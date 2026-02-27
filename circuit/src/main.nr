use dep::poseidon::poseidon2;
mod merkle_tree;

fn main(
    // public inputs
    root: pub Field,
    nullfier_hash: pub Field,
    recipient: pub Field,
    // private inputs
    secret: Field,
    nullifier: Field,
    merkle_proof: [Field; 10],
    is_even: [bool; 10],
) {
    // compute the commitment Poseidon(nullifier, secret)
    let commitment = poseidon2::Poseidon2::hash([nullifier, secret], 2);
    // check that the nullfier matches the nullifier hash
    let computed_nullifier_hash = poseidon2::Poseidon2::hash([nullifier], 1);
    assert(
        computed_nullifier_hash == nullfier_hash,
        "Computed nullifier hash does not match the provided nullifier hash",
    );
    //check the commitment is in the merkle tree
    let computed_root = merkle_tree::compute_merkle_root(commitment, merkle_proof, is_even);
    assert(computed_root == root, "Computed root does not match the provided root");

    let recipient_binding = recipient.pow_32(2); // recipient * recipient'
    // check that the recipient matches the recipient binding
    assert(
        recipient_binding == recipient * recipient,
        "Recipient does not match the recipient binding",
    );
}
