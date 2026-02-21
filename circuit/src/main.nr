use dep::poseidon::poseidon2;
mod merkle_tree;

fn main(
    // public inputs
    root: pub Field,
    nullfier_hash: pub Field,
    // private inputs
    secret: Field,
    nullifier: Field,
    merkle_proof: [Field; 20],
    is_even: [bool; 20],
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
}

// #[test]
// fn test_main() {
//     main(1, 2);

//     // Uncomment to make test fail
//     // main(1, 1);
// }
