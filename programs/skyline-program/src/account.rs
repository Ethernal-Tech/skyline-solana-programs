use crate::*;

#[account]
#[derive(InitSpace)]
pub struct ValidatorSet {
    #[max_len(MAX_VALIDATORS)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct BridgingRequest {
    pub sender: Pubkey,
    pub amount: u64,
    pub receiver: [u8; 57],
    pub destination_chain: u8,
    pub mint_token: Pubkey,
}
