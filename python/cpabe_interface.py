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


if __name__ == "__main__":
    # Demonstration of the interface (requires charm-crypto installed)
    print("CP-ABE Interface Demonstration")
    print("=" * 50)
    
    cpabe = CPABEInterface()
    
    # Setup
    pk, mk = cpabe.setup()
    print("[1] Setup complete: PK and MK generated")
    
    # Keygen for a user with attributes
    user_attrs = ['ADMIN', 'DEPT_RESEARCH']
    sk = cpabe.keygen(mk, user_attrs)
    print(f"[2] User secret key generated for attributes: {user_attrs}")
    
    # Encrypt a session key under a policy
    session_key = b"this-is-a-256-bit-session-key!!"
    policy = "(ADMIN or AUDITOR) and DEPT_RESEARCH"
    c_k = cpabe.encrypt(pk, session_key, policy)
    print(f"[3] Session key encrypted under policy: {policy}")
    
    # Decrypt with matching attributes
    decrypted = cpabe.decrypt(sk, c_k)
    print(f"[4] Decryption result: {decrypted}")
    print(f"    Match: {decrypted == session_key}")
    
    # Decrypt with non-matching attributes
    non_matching_attrs = ['DEPT_RESEARCH']
    sk2 = cpabe.keygen(mk, non_matching_attrs)
    decrypted2 = cpabe.decrypt(sk2, c_k)
    print(f"[5] Decryption with non-matching attributes: {decrypted2}")
    print("    (Expected: None — policy requires ADMIN or AUDITOR)")
