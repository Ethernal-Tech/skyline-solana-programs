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
}
