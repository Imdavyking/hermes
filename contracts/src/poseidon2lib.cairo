// poseidon2.cairo
// Poseidon2 hash function over BN254 scalar field
// Converted from: https://github.com/noir-lang/noir (acvm-repo/bn254_blackbox_solver/src/poseidon2.rs)
// Compatible with Noir proofs — uses BN254, NOT Cairo's native Stark field
//
// Usage:
//   let result = Poseidon2::hash_2(a, b);  // a, b are u256 BN254 field elements

use super::field::{Field, FieldTrait};

// -------------------------------------------------------
// Constants
// -------------------------------------------------------
const T: usize = 4;
const ROUNDS_F: usize = 8;      // external rounds
const ROUNDS_P: usize = 56;     // internal rounds
const RATE: usize = 3;
const TOTAL_ROUNDS: usize = 64; // ROUNDS_F + ROUNDS_P = 8 + 56 = 64

// -------------------------------------------------------
// Sponge state
// -------------------------------------------------------
#[derive(Drop)]
struct Sponge {
    iv: Field,
    cache: Array<Field>,       // max RATE = 3 elements
    state: Array<Field>,       // always 4 elements (T)
    cache_size: usize,
    squeeze_mode: bool,        // false = absorb, true = squeeze
}

// -------------------------------------------------------
// Public API
// -------------------------------------------------------
#[generate_trait]
pub impl Poseidon2 of Poseidon2Trait {

    fn hash_1(m: Field) -> Field {
        let mut inputs: Array<Field> = array![m];
        hash_internal(ref inputs, 1, false)
    }

    fn hash_2(m1: Field, m2: Field) -> Field {
        let mut inputs: Array<Field> = array![m1, m2];
        hash_internal(ref inputs, 2, false)
    }

    fn hash_3(m1: Field, m2: Field, m3: Field) -> Field {
        let mut inputs: Array<Field> = array![m1, m2, m3];
        hash_internal(ref inputs, 3, false)
    }

    fn hash(ref inputs: Array<Field>, std_input_length: usize, is_variable_length: bool) -> Field {
        hash_internal(ref inputs, std_input_length, is_variable_length)
    }
}

// -------------------------------------------------------
// Internal hash entry point
// -------------------------------------------------------
fn hash_internal(
    ref input: Array<Field>,
    std_input_length: usize,
    is_variable_length: bool,
) -> Field {
    let iv = generate_iv(input.len());
    let mut sponge = new_sponge(iv);

    let mut i: usize = 0;
    while i < input.len() {
        if i < std_input_length {
            absorb(ref sponge, *input[i]);
        }
        i += 1;
    }
;

    if is_variable_length {
        absorb(ref sponge, FieldTrait::new(1));
    }

    squeeze(ref sponge)
}

fn generate_iv(input_length: usize) -> Field {
    // IV = input_length << 64
    let val: u256 = (input_length.into()) * 0x10000000000000000_u256;
    FieldTrait::new_unchecked(val)
}

// -------------------------------------------------------
// Sponge construction
// -------------------------------------------------------
fn new_sponge(iv: Field) -> Sponge {
    // state[RATE] = iv, rest zero
    let state = array![
        FieldTrait::zero(),
        FieldTrait::zero(),
        FieldTrait::zero(),
        iv,
    ];
    let cache = array![
        FieldTrait::zero(),
        FieldTrait::zero(),
        FieldTrait::zero(),
    ];
    Sponge {
        iv,
        cache,
        state,
        cache_size: 0,
        squeeze_mode: false,
    }
}

fn absorb(ref self: Sponge, input: Field) {
    if !self.squeeze_mode && self.cache_size == RATE {
        // cache full — apply permutation, reset cache
        perform_duplex(ref self);
        self.cache = array![input, FieldTrait::zero(), FieldTrait::zero()];
        self.cache_size = 1;
    } else if !self.squeeze_mode && self.cache_size != RATE {
        // cache not full — append to cache
        // We can't index-assign Arrays in Cairo, so rebuild
        let mut new_cache: Array<Field> = ArrayTrait::new();
        let mut j: usize = 0;
        while j < RATE {
            if j < self.cache_size {
                new_cache.append(*self.cache[j]);
            } else if j == self.cache_size {
                new_cache.append(input);
            } else {
                new_cache.append(FieldTrait::zero());
            }
            j += 1;
        }
;
        self.cache = new_cache;
        self.cache_size += 1;
    }
    // in squeeze mode: ignore (matches Solidity behavior)
}

fn squeeze(ref self: Sponge) -> Field {
    if !self.squeeze_mode {
        let new_output = perform_duplex(ref self);
        self.squeeze_mode = true;
        self.cache = array![*new_output[0], *new_output[1], *new_output[2]];
        self.cache_size = RATE;
    }

    // pop first element from cache
    let result = *self.cache[0];
    let mut new_cache: Array<Field> = ArrayTrait::new();
    let mut i: usize = 1;
    while i < RATE {
        if i < self.cache_size {
            new_cache.append(*self.cache[i]);
        } else {
            new_cache.append(FieldTrait::zero());
        }
        i += 1;
    }
;
    new_cache.append(FieldTrait::zero()); // pad to RATE size
    self.cache = new_cache;
    self.cache_size -= 1;

    result
}

fn perform_duplex(ref self: Sponge) -> Array<Field> {
    // xor cache into state (add in field)
    let mut new_state: Array<Field> = ArrayTrait::new();
    let mut i: usize = 0;
    while i < T {
        if i < RATE {
            let cache_val = if i < self.cache_size {
                *self.cache[i]
            } else {
                FieldTrait::zero()
            };
            new_state.append(FieldTrait::add(*self.state[i], cache_val));
        } else {
            new_state.append(*self.state[i]);
        }
        i += 1;
    }
;
    self.state = new_state;

    // apply permutation
    self.state = permutation(ref self.state);

    // return first RATE elements
    array![*self.state[0], *self.state[1], *self.state[2]]
}

// -------------------------------------------------------
// Permutation
// -------------------------------------------------------
fn permutation(ref inputs: Array<Field>) -> Array<Field> {
    let mut state: Array<Field> = array![
        *inputs[0], *inputs[1], *inputs[2], *inputs[3]
    ];

    // 1. initial linear layer
    matrix_multiplication_4x4(ref state);

    // 2. first RF/2 external rounds
    let rf_first = ROUNDS_F / 2; // = 4
    let mut r: usize = 0;
    while r < rf_first {
        add_round_constants(ref state, r);
        s_box_full(ref state);
        matrix_multiplication_4x4(ref state);
        r += 1;
    }
;

    // 3. ROUNDS_P internal rounds
    let p_end = rf_first + ROUNDS_P; // 4 + 56 = 60
    let mut r = rf_first;
    while r < p_end {
        // only add round constant to state[0]
        let rc = round_constant_0(r);
        let s0 = *state[0];
        let new_s0 = single_box(FieldTrait::add(s0, rc));
        state = array![new_s0, *state[1], *state[2], *state[3]];
        internal_m_multiplication(ref state);
        r += 1;
    }
;

    // 4. remaining RF/2 external rounds
    let num_rounds = ROUNDS_F + ROUNDS_P; // = 64
    let mut r = p_end;
    while r < num_rounds {
        add_round_constants(ref state, r);
        s_box_full(ref state);
        matrix_multiplication_4x4(ref state);
        r += 1;
    }
;

    state
}

// -------------------------------------------------------
// S-box: x^5 mod BN254_PRIME
// -------------------------------------------------------
fn single_box(x: Field) -> Field {
    let s = FieldTrait::mul(x, x);       // x^2
    let s2 = FieldTrait::mul(s, s);      // x^4
    FieldTrait::mul(s2, x)               // x^5
}

fn s_box_full(ref state: Array<Field>) {
    state = array![
        single_box(*state[0]),
        single_box(*state[1]),
        single_box(*state[2]),
        single_box(*state[3]),
    ];
}

// -------------------------------------------------------
// Matrix multiplication (MDS) — same as Solidity
// -------------------------------------------------------
fn matrix_multiplication_4x4(ref input: Array<Field>) {
    let a = *input[0];
    let b = *input[1];
    let c = *input[2];
    let d = *input[3];

    let t0 = FieldTrait::add(a, b);           // A + B
    let t1 = FieldTrait::add(c, d);           // C + D
    let t2 = FieldTrait::add(FieldTrait::add(b, b), t1);  // 2B + C + D
    let t3 = FieldTrait::add(FieldTrait::add(d, d), t0);  // 2D + A + B
    let t4 = FieldTrait::add(
        FieldTrait::add(FieldTrait::add(t1, t1), FieldTrait::add(t1, t1)),
        t3
    );  // A + B + 4C + 6D
    let t5 = FieldTrait::add(
        FieldTrait::add(FieldTrait::add(t0, t0), FieldTrait::add(t0, t0)),
        t2
    );  // 4A + 6B + C + D
    let t6 = FieldTrait::add(t3, t5);  // 5A + 7B + C + 3D
    let t7 = FieldTrait::add(t2, t4);  // A + 3B + 5C + 7D

    input = array![t6, t5, t7, t4];
}

fn internal_m_multiplication(ref input: Array<Field>) {
    let diag = internal_matrix_diagonal();

    // sum all elements
    let sum = FieldTrait::add(
        FieldTrait::add(*input[0], *input[1]),
        FieldTrait::add(*input[2], *input[3]),
    );

    // input[i] = input[i] * diag[i] + sum
    input = array![
        FieldTrait::add(FieldTrait::mul(*input[0], *diag[0]), sum),
        FieldTrait::add(FieldTrait::mul(*input[1], *diag[1]), sum),
        FieldTrait::add(FieldTrait::mul(*input[2], *diag[2]), sum),
        FieldTrait::add(FieldTrait::mul(*input[3], *diag[3]), sum),
    ];
}

// -------------------------------------------------------
// Round constants — split into two helpers to avoid
// massive match arms in a single function
// -------------------------------------------------------

// Returns all 4 round constants for external rounds (r < 4 or r >= 60)
fn add_round_constants(ref state: Array<Field>, round: usize) {
    let rc = round_constants_full(round);
    state = array![
        FieldTrait::add(*state[0], *rc[0]),
        FieldTrait::add(*state[1], *rc[1]),
        FieldTrait::add(*state[2], *rc[2]),
        FieldTrait::add(*state[3], *rc[3]),
    ];
}

// Returns just state[0] round constant for internal rounds
fn round_constant_0(round: usize) -> Field {
    // Internal rounds: r = 4..60, only first constant is nonzero
    let val: u256 = match round {
        4  => 0x0c6f8f958be0e93053d7fd4fc54512855535ed1539f051dcb43a26fd926361cf,
        5  => 0x123106a93cd17578d426e8128ac9d90aa9e8a00708e296e084dd57e69caaf811,
        6  => 0x26e1ba52ad9285d97dd3ab52f8e840085e8fa83ff1e8f1877b074867cd2dee75,
        7  => 0x1cb55cad7bd133de18a64c5c47b9c97cbe4d8b7bf9e095864471537e6a4ae2c5,
        8  => 0x1dcd73e46acd8f8e0e2c7ce04bde7f6d2a53043d5060a41c7143f08e6e9055d0,
        9  => 0x011003e32f6d9c66f5852f05474a4def0cda294a0eb4e9b9b12b9bb4512e5574,
        10 => 0x2b1e809ac1d10ab29ad5f20d03a57dfebadfe5903f58bafed7c508dd2287ae8c,
        11 => 0x2539de1785b735999fb4dac35ee17ed0ef995d05ab2fc5faeaa69ae87bcec0a5,
        12 => 0x0c246c5a2ef8ee0126497f222b3e0a0ef4e1c3d41c86d46e43982cb11d77951d,
        13 => 0x192089c4974f68e95408148f7c0632edbb09e6a6ad1a1c2f3f0305f5d03b527b,
        14 => 0x1eae0ad8ab68b2f06a0ee36eeb0d0c058529097d91096b756d8fdc2fb5a60d85,
        15 => 0x179190e5d0e22179e46f8282872abc88db6e2fdc0dee99e69768bd98c5d06bfb,
        16 => 0x29bb9e2c9076732576e9a81c7ac4b83214528f7db00f31bf6cafe794a9b3cd1c,
        17 => 0x225d394e42207599403efd0c2464a90d52652645882aac35b10e590e6e691e08,
        18 => 0x064760623c25c8cf753d238055b444532be13557451c087de09efd454b23fd59,
        19 => 0x10ba3a0e01df92e87f301c4b716d8a394d67f4bf42a75c10922910a78f6b5b87,
        20 => 0x0e070bf53f8451b24f9c6e96b0c2a801cb511bc0c242eb9d361b77693f21471c,
        21 => 0x1b94cd61b051b04dd39755ff93821a73ccd6cb11d2491d8aa7f921014de252fb,
        22 => 0x1d7cb39bafb8c744e148787a2e70230f9d4e917d5713bb050487b5aa7d74070b,
        23 => 0x2ec93189bd1ab4f69117d0fe980c80ff8785c2961829f701bb74ac1f303b17db,
        24 => 0x2db366bfdd36d277a692bb825b86275beac404a19ae07a9082ea46bd83517926,
        25 => 0x062100eb485db06269655cf186a68532985275428450359adc99cec6960711b8,
        26 => 0x0761d33c66614aaa570e7f1e8244ca1120243f92fa59e4f900c567bf41f5a59b,
        27 => 0x20fc411a114d13992c2705aa034e3f315d78608a0f7de4ccf7a72e494855ad0d,
        28 => 0x25b5c004a4bdfcb5add9ec4e9ab219ba102c67e8b3effb5fc3a30f317250bc5a,
        29 => 0x23b1822d278ed632a494e58f6df6f5ed038b186d8474155ad87e7dff62b37f4b,
        30 => 0x22734b4c5c3f9493606c4ba9012499bf0f14d13bfcfcccaa16102a29cc2f69e0,
        31 => 0x26c0c8fe09eb30b7e27a74dc33492347e5bdff409aa3610254413d3fad795ce5,
        32 => 0x070dd0ccb6bd7bbae88eac03fa1fbb26196be3083a809829bbd626df348ccad9,
        33 => 0x12b6595bdb329b6fb043ba78bb28c3bec2c0a6de46d8c5ad6067c4ebfd4250da,
        34 => 0x248d97d7f76283d63bec30e7a5876c11c06fca9b275c671c5e33d95bb7e8d729,
        35 => 0x1a306d439d463b0816fc6fd64cc939318b45eb759ddde4aa106d15d9bd9baaaa,
        36 => 0x28a8f8372e3c38daced7c00421cb4621f4f1b54ddc27821b0d62d3d6ec7c56cf,
        37 => 0x0094975717f9a8a8bb35152f24d43294071ce320c829f388bc852183e1e2ce7e,
        38 => 0x04d5ee4c3aa78f7d80fde60d716480d3593f74d4f653ae83f4103246db2e8d65,
        39 => 0x2a6cf5e9aa03d4336349ad6fb8ed2269c7bef54b8822cc76d08495c12efde187,
        40 => 0x2304d31eaab960ba9274da43e19ddeb7f792180808fd6e43baae48d7efcba3f3,
        41 => 0x03fd9ac865a4b2a6d5e7009785817249bff08a7e0726fcb4e1c11d39d199f0b0,
        42 => 0x00b7258ded52bbda2248404d55ee5044798afc3a209193073f7954d4d63b0b64,
        43 => 0x159f81ada0771799ec38fca2d4bf65ebb13d3a74f3298db36272c5ca65e92d9a,
        44 => 0x1ef90e67437fbc8550237a75bc28e3bb9000130ea25f0c5471e144cf4264431f,
        45 => 0x1e65f838515e5ff0196b49aa41a2d2568df739bc176b08ec95a79ed82932e30d,
        46 => 0x2b1b045def3a166cec6ce768d079ba74b18c844e570e1f826575c1068c94c33f,
        47 => 0x0832e5753ceb0ff6402543b1109229c165dc2d73bef715e3f1c6e07c168bb173,
        48 => 0x02f614e9cedfb3dc6b762ae0a37d41bab1b841c2e8b6451bc5a8e3c390b6ad16,
        49 => 0x0e2427d38bd46a60dd640b8e362cad967370ebb777bedff40f6a0be27e7ed705,
        50 => 0x0493630b7c670b6deb7c84d414e7ce79049f0ec098c3c7c50768bbe29214a53a,
        51 => 0x22ead100e8e482674decdab17066c5a26bb1515355d5461a3dc06cc85327cea9,
        52 => 0x25b3e56e655b42cdaae2626ed2554d48583f1ae35626d04de5084e0b6d2a6f16,
        53 => 0x1e32752ada8836ef5837a6cde8ff13dbb599c336349e4c584b4fdc0a0cf6f9d0,
        54 => 0x2fa2a871c15a387cc50f68f6f3c3455b23c00995f05078f672a9864074d412e5,
        55 => 0x2f569b8a9a4424c9278e1db7311e889f54ccbf10661bab7fcd18e7c7a7d83505,
        56 => 0x044cb455110a8fdd531ade530234c518a7df93f7332ffd2144165374b246b43d,
        57 => 0x227808de93906d5d420246157f2e42b191fe8c90adfe118178ddc723a5319025,
        58 => 0x02fcca2934e046bc623adead873579865d03781ae090ad4a8579d2e7a6800355,
        59 => 0x0ef915f0ac120b876abccceb344a1d36bad3f3c5ab91a8ddcbec2e060d8befac,
        _  => 0,
    };
    FieldTrait::new_unchecked(val)
}

// Returns all 4 constants for external rounds (0..4 and 60..64)
fn round_constants_full(round: usize) -> Array<Field> {
    let (c0, c1, c2, c3): (u256, u256, u256, u256) = match round {
        0 => (
            0x19b849f69450b06848da1d39bd5e4a4302bb86744edc26238b0878e269ed23e5,
            0x265ddfe127dd51bd7239347b758f0a1320eb2cc7450acc1dad47f80c8dcf34d6,
            0x199750ec472f1809e0f66a545e1e51624108ac845015c2aa3dfc36bab497d8aa,
            0x157ff3fe65ac7208110f06a5f74302b14d743ea25067f0ffd032f787c7f1cdf8,
        ),
        1 => (
            0x2e49c43c4569dd9c5fd35ac45fca33f10b15c590692f8beefe18f4896ac94902,
            0x0e35fb89981890520d4aef2b6d6506c3cb2f0b6973c24fa82731345ffa2d1f1e,
            0x251ad47cb15c4f1105f109ae5e944f1ba9d9e7806d667ffec6fe723002e0b996,
            0x13da07dc64d428369873e97160234641f8beb56fdd05e5f3563fa39d9c22df4e,
        ),
        2 => (
            0x0c009b84e650e6d23dc00c7dccef7483a553939689d350cd46e7b89055fd4738,
            0x011f16b1c63a854f01992e3956f42d8b04eb650c6d535eb0203dec74befdca06,
            0x0ed69e5e383a688f209d9a561daa79612f3f78d0467ad45485df07093f367549,
            0x04dba94a7b0ce9e221acad41472b6bbe3aec507f5eb3d33f463672264c9f789b,
        ),
        3 => (
            0x0a3f2637d840f3a16eb094271c9d237b6036757d4bb50bf7ce732ff1d4fa28e8,
            0x259a666f129eea198f8a1c502fdb38fa39b1f075569564b6e54a485d1182323f,
            0x28bf7459c9b2f4c6d8e7d06a4ee3a47f7745d4271038e5157a32fdf7ede0d6a1,
            0x0a1ca941f057037526ea200f489be8d4c37c85bbcce6a2aeec91bd6941432447,
        ),
        // rounds 4..60 are internal (only c0 used, handled by round_constant_0)
        // rounds 60..64 are external again
        60 => (
            0x1797130f4b7a3e1777eb757bc6f287f6ab0fb85f6be63b09f3b16ef2b1405d38,
            0x0a76225dc04170ae3306c85abab59e608c7f497c20156d4d36c668555decc6e5,
            0x1fffb9ec1992d66ba1e77a7b93209af6f8fa76d48acb664796174b5326a31a5c,
            0x25721c4fc15a3f2853b57c338fa538d85f8fbba6c6b9c6090611889b797b9c5f,
        ),
        61 => (
            0x0c817fd42d5f7a41215e3d07ba197216adb4c3790705da95eb63b982bfcaf75a,
            0x13abe3f5239915d39f7e13c2c24970b6df8cf86ce00a22002bc15866e52b5a96,
            0x2106feea546224ea12ef7f39987a46c85c1bc3dc29bdbd7a92cd60acb4d391ce,
            0x21ca859468a746b6aaa79474a37dab49f1ca5a28c748bc7157e1b3345bb0f959,
        ),
        62 => (
            0x05ccd6255c1e6f0c5cf1f0df934194c62911d14d0321662a8f1a48999e34185b,
            0x0f0e34a64b70a626e464d846674c4c8816c4fb267fe44fe6ea28678cb09490a4,
            0x0558531a4e25470c6157794ca36d0e9647dbfcfe350d64838f5b1a8a2de0d4bf,
            0x09d3dca9173ed2faceea125157683d18924cadad3f655a60b72f5864961f1455,
        ),
        63 => (
            0x0328cbd54e8c0913493f866ed03d218bf23f92d68aaec48617d4c722e5bd4335,
            0x2bf07216e2aff0a223a487b1a7094e07e79e7bcc9798c648ee3347dd5329d34b,
            0x1daf345a58006b736499c583cb76c316d6f78ed6a6dffc82111e11a63fe412df,
            0x176563472456aaa746b694c60e1823611ef39039b2edc7ff391e6f2293d2c404,
        ),
        _ => (0, 0, 0, 0),
    };

    array![
        FieldTrait::new_unchecked(c0),
        FieldTrait::new_unchecked(c1),
        FieldTrait::new_unchecked(c2),
        FieldTrait::new_unchecked(c3),
    ]
}

fn internal_matrix_diagonal() -> Array<Field> {
    array![
        FieldTrait::new_unchecked(0x10dc6e9c006ea38b04b1e03b4bd9490c0d03f98929ca1d7fb56821fd19d3b6e7),
        FieldTrait::new_unchecked(0x0c28145b6a44df3e0149b3d0a30b3bb599df9756d4dd9b84a86b38cfb45a740b),
        FieldTrait::new_unchecked(0x00544b8338791518b2c7645a50392798b21f75bb60e3596170067d00141cac15),
        FieldTrait::new_unchecked(0x222c01175718386f2e2e82eb122789e352e105a3b8fa852613bc534433ee428b),
    ]
}
