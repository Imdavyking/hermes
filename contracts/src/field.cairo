// field.cairo
// BN254 scalar field arithmetic for Cairo
// Used for compatibility with Noir proofs (which use BN254)

const BN254_PRIME: u256 = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

const BN254_PRIME_DIV_2: u256 = 0x183227397098d014dc2822db40c0ac2ecf17f7f1f01d00000000000000000000;

#[derive(Copy, Drop)]
pub struct Field {
    pub inner: u256,
}

#[generate_trait]
pub impl FieldImpl of FieldTrait {
    // -------------------------------------------------------
    // Constructors
    // -------------------------------------------------------

    fn new(value: u256) -> Field {
        assert(value < BN254_PRIME, 'Field: input too large');
        Field { inner: value }
    }

    fn new_unchecked(value: u256) -> Field {
        Field { inner: value }
    }

    fn zero() -> Field {
        Field { inner: 0 }
    }

    fn from_felt(value: felt252) -> Field {
        let as_u256: u256 = value.into();
        assert(as_u256 < BN254_PRIME, 'Field: felt too large for BN254');
        Field { inner: as_u256 }
    }

    fn from_address(addr: starknet::ContractAddress) -> Field {
        let as_felt: felt252 = addr.into();
        let as_u256: u256 = as_felt.into();
        Field { inner: as_u256 }
    }

    // -------------------------------------------------------
    // Conversions out
    // -------------------------------------------------------

    fn to_felt(self: Field) -> felt252 {
        // only safe if value fits in felt252 (Stark prime > BN254 prime, so always ok)
        let low: felt252 = self.inner.low.into();
        let high: felt252 = self.inner.high.into();
        low + high * 0x100000000000000000000000000000000
    }


    fn inner(self: Field) -> u256 {
        self.inner
    }

    // -------------------------------------------------------
    // Checks
    // -------------------------------------------------------

    fn check(self: Field) {
        assert(self.inner < BN254_PRIME, 'Field: input too large');
    }

    fn is_zero(self: Field) -> bool {
        self.inner == 0
    }

    // -------------------------------------------------------
    // Arithmetic (mod BN254_PRIME)
    // -------------------------------------------------------

    fn add(self: Field, other: Field) -> Field {
        let sum = self.inner + other.inner;
        // reduce mod prime (sum can overflow by at most 1x prime)
        if sum >= BN254_PRIME {
            Field { inner: sum - BN254_PRIME }
        } else {
            Field { inner: sum }
        }
    }

    fn add_u256(self: Field, other: u256) -> Field {
        let other_field = Self::new(other);
        self.add(other_field)
    }

    fn mul(self: Field, other: Field) -> Field {
        // u256 * u256 needs u512 — use mulmod pattern
        // Cairo doesn't have native u512, so we use the circuit hint
        let result = field_mulmod(self.inner, other.inner, BN254_PRIME);
        Field { inner: result }
    }

    fn mul_u256(self: Field, other: u256) -> Field {
        let other_field = Self::new(other);
        self.mul(other_field)
    }

    fn eq(self: Field, other: Field) -> bool {
        self.inner == other.inner
    }

    // -------------------------------------------------------
    // Signed interpretation (same as Solidity version)
    // Returns (is_positive, scalar)
    // Values > PRIME/2 are treated as negative
    // -------------------------------------------------------
    fn signed(self: Field) -> (bool, u256) {
        if self.inner > BN254_PRIME_DIV_2 {
            (false, BN254_PRIME - self.inner)
        } else {
            (true, self.inner)
        }
    }
}
use core::integer::u512_safe_div_rem_by_u256;

// -------------------------------------------------------
// mulmod for u256 — computes (a * b) % m
// Uses u512 via splitting into 128-bit limbs
// -------------------------------------------------------

use core::num::traits::WideMul;
fn field_mulmod(a: u256, b: u256, m: u256) -> u256 {
    let wide = a.wide_mul(b);
    let (_, rem) = u512_safe_div_rem_by_u256(wide, m.try_into().expect('division by zero'));
    rem
}
