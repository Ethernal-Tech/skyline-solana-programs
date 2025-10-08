use anchor_lang::prelude::*;
use crate::*;

#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub bump: u8,
}