use anchor_lang::prelude::*;

declare_id!("9r3WeS5AWMXnnt1vepkq8RkaTsR5RYtv7cgBRZ3fs6q3");

#[program]
pub mod skyline_program {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
