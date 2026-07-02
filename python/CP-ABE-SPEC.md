# CP-ABE Interface Specification for B-DCSAC

## Overview

This document specifies the Ciphertext-Policy Attribute-Based Encryption (CP-ABE) interface for B-DCSAC. The CP-ABE layer is implemented as an **architectural interface specification** using the standard **BSWABE** construction (Bethencourt-Sahai-Waters) via the **Charm-Crypto** library. Full empirical performance measurement is reserved for future work; the current prototype validates the architectural integration and measures AES-256-GCM performance only.

## Standard Backend

- **Library:** [Charm-Crypto](https://github.com/JHUISI/charm) (Python)
- **Scheme:** CPabe_BSW07 (Bethencourt-Sahai-Waters CP-ABE)
- **Curve:** SS512 (symmetric pairing over supersingular curve)
- **Hybrid Mode:** HybridABEnc (AES + CP-ABE envelope)

## Interface Functions

| Function | Input | Output |
|----------|-------|--------|
| `setup()` | Security parameter `λ` (implicit via curve) | `(PK, MK)` — public key, master key |
| `keygen(MK, S)` | Master key `MK`, attribute set `S` | `SK` — user secret key |
| `encrypt(PK, M, P_A)` | Public key `PK`, message `M`, policy string `P_A` | `C_K` — CP-ABE ciphertext |
| `decrypt(SK, C_K)` | Secret key `SK`, ciphertext `C_K` | `M` or `⊥` (failure if attributes don't satisfy policy) |

## Python Interface Stub

```python
# cpabe_interface.py — BSWABE interface specification for B-DCSAC
# Intended backend: Charm-Crypto (https://github.com/JHUISI/charm)
# Full implementation deferred to future work.

from charm.toolbox.pairinggroup import PairingGroup
from charm.adapters.abenc_adapt_hybrid import HybridABEnc
from charm.schemes.abenc.abenc_bsw07 import CPabe_BSW07

class CPABEInterface:
    def __init__(self, curve='SS512'):
        self.group = PairingGroup(curve)
        self.cpabe = CPabe_BSW07(self.group)
        self.hybrid = HybridABEnc(self.cpabe, self.group)
    
    def setup(self):
        """Returns (public_key, master_key)"""
        return self.cpabe.setup()
    
    def keygen(self, mk, attributes):
        """Returns private key for attribute set.
        
        Args:
            mk: Master key from setup()
            attributes: List of string attributes, e.g., ['ADMIN', 'DEPT_FINANCE']
        """
        return self.cpabe.keygen(mk, attributes)
    
    def encrypt(self, pk, plaintext, policy):
        """Returns CP-ABE ciphertext under policy string.
        
        Args:
            pk: Public key from setup()
            plaintext: Plaintext message (bytes or str)
            policy: Policy string, e.g., "(ADMIN or AUDITOR) and DEPT_FINANCE"
        """
        return self.hybrid.encrypt(pk, plaintext, policy)
    
    def decrypt(self, sk, ciphertext):
        """Returns plaintext or None if attributes do not satisfy policy.
        
        Args:
            sk: Secret key from keygen()
            ciphertext: Ciphertext from encrypt()
        """
        try:
            return self.hybrid.decrypt(sk, ciphertext)
        except Exception:
            return None
```

## Integration Points in B-DCSAC

The CP-ABE interface is invoked at two architectural boundaries:

### 1. Upload (Algorithm 3, Step 8)

```python
# After AES-256-GCM file encryption:
ks = generate_random_key(256)  # Session key
# ... encrypt file with AES-256-GCM ...

# CP-ABE wrapping (interface specification):
cpabe = CPABEInterface()
pk, mk = cpabe.setup()  # Or load existing PK/MK
policy = "(OWNER or ADMIN) and (DEPT_RESEARCH or DEPT_FINANCE)"
c_k = cpabe.encrypt(pk, ks, policy)  # Wrap K_s under CP-ABE policy
```

### 2. Retrieval (Algorithm 4, Step 12)

```python
# After access validation succeeds:
# ... fetch CID and encrypted key material ...

# CP-ABE unwrapping (interface specification):
sk = cpabe.keygen(mk, user_attributes)  # Load user's secret key
ks = cpabe.decrypt(sk, c_k)  # Unwrap K_s
if ks is None:
    raise AccessDenied("Attributes do not satisfy policy")
# ... decrypt file with AES-256-GCM ...
```

## Implementation Notes

1. **Environment Requirements:** Charm-Crypto requires the PBC library (`libpbc-dev`) and OpenSSL development headers. Installation on Ubuntu/Debian:
   ```bash
   sudo apt-get install libpbc-dev libssl-dev
   pip install charm-crypto
   ```
   On Windows, WSL2 is recommended for Charm-Crypto compilation.

2. **Performance Expectation:** CP-ABE pairing operations are orders of magnitude slower than AES-256-GCM. Empirical studies report CP-ABE encryption at ~50–200 ms for small policies and decryption at ~30–100 ms on modern hardware. The AES-256-GCM measurements in Table 7 of the paper reflect the symmetric layer only; CP-ABE overhead is not included in the prototype latency figures.

3. **Policy Language:** The BSWABE scheme uses LSSS (Linear Secret Sharing Scheme) access policies. Policy strings use AND/OR boolean expressions over attributes, e.g., `"(A and B) or (C and D)"`.

4. **Key Management:** The master key `MK` must be stored offline or in a hardware security module. The public key `PK` is distributed to all encrypters. User secret keys `SK` are generated by the key authority and distributed securely to legitimate users.

5. **Revocation:** Attribute revocation in CP-ABE requires either:
   - **Proxy re-encryption:** A semi-trusted proxy re-encrypts ciphertext for remaining users (requires additional infrastructure).
   - **Key update:** The key authority issues new secret keys to non-revoked users and updates the public parameters. In B-DCSAC, this is handled at the **off-chain key service layer** triggered by the `TriggerRekeying` event in Algorithm 5.

## Future Work

- Full Charm-Crypto integration with empirical latency measurement
- Attribute revocation via proxy re-encryption
- Policy hiding extensions (attribute values hidden from encryptor)
- Multi-authority CP-ABE to eliminate single key authority trust

## License

MIT — same as B-DCSAC core.
