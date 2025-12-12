pub fn calculate_threshold(num_signers: usize) -> u8 {
    (((num_signers as f32) - 1.0) * 2.0 / 3.0).floor() as u8
}
