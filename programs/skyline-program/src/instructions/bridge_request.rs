use crate::*;
use anchor_spl::token::{self, Burn, Mint, TokenAccount};

#[derive(Accounts)]
pub struct BridgeRequest<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer
    )]
    pub signers_ata: Account<'info, TokenAccount>,

    #[account(init,
        payer = signer,
        space = DISC + BridgingRequest::INIT_SPACE,
        seeds = [BRIDGING_REQUEST_SEED, signer.key().as_ref()],
        bump
    )]
    pub bridging_request: Account<'info, BridgingRequest>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, anchor_spl::token::Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> BridgeRequest<'info> {
    pub fn process_instruction(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: [u8; 57],
        destination_chain: u8,
    ) -> Result<()> {
        let mint = &ctx.accounts.mint;
        let from = &ctx.accounts.signers_ata;
        let signer = &ctx.accounts.signer;
        let token_program = &ctx.accounts.token_program;
        require!(from.amount >= amount, CustomError::InsufficientFunds);

        let cpi_accounts = Burn {
            mint: mint.to_account_info(),
            from: from.to_account_info(),
            authority: signer.to_account_info(),
        };

        let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
        token::burn(cpi_context, amount)?;

        let bridging_request = &mut ctx.accounts.bridging_request;
        bridging_request.sender = ctx.accounts.signer.key();
        bridging_request.amount = amount;
        bridging_request.receiver = receiver;
        bridging_request.destination_chain = destination_chain;
        bridging_request.mint_token = ctx.accounts.mint.key();

        Ok(())
    }
}
