//! Bridge request instruction for creating cross-chain transfer requests.
//!
//! This module contains the logic for creating bridging requests that initiate
//! cross-chain token transfers. Users can burn tokens on the source chain and
//! create a request that validators can process to mint equivalent tokens on
//! the destination chain.

use crate::*;
use anchor_spl::token::{self, Burn, Mint, TokenAccount};

/// Account structure for the bridge_request instruction.
///
/// This struct defines the accounts required to create a bridging request.
/// It includes the user's token account, the bridging request account to be created,
/// and the token mint for the tokens being bridged.
#[derive(Accounts)]
pub struct BridgeRequest<'info> {
    /// The user initiating the bridge request
    #[account(mut)]
    pub signer: Signer<'info>,
    
    /// The user's associated token account for the tokens being bridged
    #[account(
        mut,
        token::mint = mint,
        token::authority = signer
    )]
    pub signers_ata: Account<'info, TokenAccount>,

    /// The bridging request account to be created
    #[account(init,
        payer = signer,
        space = DISC + BridgingRequest::INIT_SPACE,
        seeds = [BRIDGING_REQUEST_SEED, signer.key().as_ref()],
        bump
    )]
    pub bridging_request: Account<'info, BridgingRequest>,

    /// The token mint for the tokens being bridged
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    
    /// The token program for burning operations
    pub token_program: Program<'info, anchor_spl::token::Token>,
    
    /// The system program for account creation
    pub system_program: Program<'info, System>,
}

impl<'info> BridgeRequest<'info> {
    /// Process the bridge_request instruction.
    ///
    /// This function validates the user has sufficient tokens, burns the specified amount,
    /// and creates a bridging request account with the transfer details. The request can
    /// then be processed by validators to mint equivalent tokens on the destination chain.
    ///
    /// # Arguments
    /// * `ctx` - The instruction context containing all required accounts
    /// * `amount` - The amount of tokens to bridge to the destination chain
    /// * `receiver` - The receiver's address on the destination chain (57 bytes)
    /// * `destination_chain` - The chain ID of the destination blockchain
    ///
    /// # Returns
    /// * `Result<()>` - Returns Ok(()) on success or an error on failure
    ///
    /// # Errors
    /// * `InsufficientFunds` - If the user doesn't have enough tokens to bridge
    ///
    /// # Process Flow
    /// 1. Validates that the user has sufficient token balance
    /// 2. Burns the specified amount of tokens from the user's account
    /// 3. Creates a bridging request account with transfer details
    /// 4. Stores the request information for validator processing
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
        
        // Validate that the user has sufficient tokens to bridge
        require!(from.amount >= amount, CustomError::InsufficientFunds);

        // Prepare the burn instruction
        let cpi_accounts = Burn {
            mint: mint.to_account_info(),
            from: from.to_account_info(),
            authority: signer.to_account_info(),
        };

        // Execute the token burn
        let cpi_context = CpiContext::new(token_program.to_account_info(), cpi_accounts);
        token::burn(cpi_context, amount)?;

        // Create and populate the bridging request account
        let bridging_request = &mut ctx.accounts.bridging_request;
        bridging_request.sender = ctx.accounts.signer.key();
        bridging_request.amount = amount;
        bridging_request.receiver = receiver;
        bridging_request.destination_chain = destination_chain;
        bridging_request.mint_token = ctx.accounts.mint.key();

        Ok(())
    }
}
