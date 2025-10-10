use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token,
    token::{self, Mint, MintTo, Token},
};

use crate::*;

#[derive(Accounts)]
pub struct BridgeTokens<'info> {
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        seeds = [VALIDATOR_SET_SEED],
        bump = validator_set.bump,
    )]
    pub validator_set: Account<'info, ValidatorSet>,
    /// CHECK: This is the recipient of the bridged tokens
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: This is the recipient's associated token account
    #[account(mut)]
    pub recipient_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, associated_token::AssociatedToken>,
}

impl<'info> BridgeTokens<'info> {
    pub fn process_instruction(ctx: Context<Self>, amount: u64) -> Result<()> {
        let token_program = &ctx.accounts.token_program;
        let validator_set = &ctx.accounts.validator_set;
        let recipient = &ctx.accounts.recipient;
        let recipient_ata = &ctx.accounts.recipient_ata;
        let mint = &ctx.accounts.mint;
        let associated_token_program = &ctx.accounts.associated_token_program;

        let signers = ctx
            .remaining_accounts
            .iter()
            .filter(|acc| acc.is_signer)
            .collect::<Vec<&AccountInfo>>();

        require!(
            signers.len() as u8 >= ctx.accounts.validator_set.threshold,
            CustomError::NotEnoughSigners
        );

        for signer in signers {
            require!(
                validator_set.signers.contains(signer.key),
                CustomError::InvalidSigner
            );
        }

        if recipient_ata.data_is_empty() {
            let cpi_context = CpiContext::new(
                associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: ctx.accounts.payer.to_account_info(),
                    associated_token: recipient_ata.to_account_info(),
                    authority: recipient.to_account_info(),
                    mint: mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: token_program.to_account_info(),
                },
            );

            associated_token::create(cpi_context)?;
        }

        let cpi_accounts = MintTo {
            mint: mint.to_account_info(),
            to: recipient_ata.to_account_info(),
            authority: validator_set.to_account_info(),
        };

        let seeds = &[VALIDATOR_SET_SEED, &[validator_set.bump]];
        let signer_seeds = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            ),
            amount,
        )?;

        Ok(())
    }
}
