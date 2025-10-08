use anchor_lang::prelude::*;

#[error_code]
pub enum CustomError {
    #[msg("Maximum number of validators exceeded")]
    MaxValidatorsExceeded,
    #[msg("Minimum number of validators not met")]
    MinValidatorsNotMet,
    #[msg("Validators need to be unique")]
    ValidatorsNotUnique,
}