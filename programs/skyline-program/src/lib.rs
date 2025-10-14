use anchor_lang::prelude::*;

pub mod account;
pub use account::*;

pub mod constant;
pub use constant::*;

pub mod error;
pub use error::*;

pub mod instructions;
pub use instructions::*;

declare_id!("9r3WeS5AWMXnnt1vepkq8RkaTsR5RYtv7cgBRZ3fs6q3");

#[program]
pub mod skyline_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, validators: Vec<Pubkey>) -> Result<()> {
        Initialize::process_instruction(ctx, validators)
    }

    pub fn bridge_tokens(ctx: Context<BridgeTokens>, amount: u64) -> Result<()> {
        BridgeTokens::process_instruction(ctx, amount)
    }

    pub fn bridge_request(
        ctx: Context<BridgeRequest>,
        amount: u64,
        receiver: [u8; 57],
        destination_chain: u8,
    ) -> Result<()> {
        BridgeRequest::process_instruction(ctx, amount, receiver, destination_chain)
    }

    pub fn validator_set_change(
        ctx: Context<ValidatorSetChange>,
        new_validator_set: Vec<Pubkey>,
    ) -> Result<()> {
        ValidatorSetChange::process_instruction(ctx, new_validator_set)
    }

    pub fn close_request(ctx: Context<CloseRequest>) -> Result<()> {
        CloseRequest::process_instruction(ctx)
    }
}
