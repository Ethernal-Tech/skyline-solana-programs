pub fn calculate_threshold(num_signers: usize) -> u8 {
    num_signers as u8 - (((num_signers as f32) - 1.0) / 3.0).floor() as u8
}
