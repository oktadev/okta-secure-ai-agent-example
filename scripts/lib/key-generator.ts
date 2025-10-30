import * as jose from 'jose';
import * as fs from 'fs';
import * as path from 'path';

export interface KeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
  certificate: string;
}

/**
 * Generate an RSA key pair for JWT authentication
 * Returns private key and public key in PEM format
 * Note: certificate field is kept for backward compatibility but not used
 */
export async function generateRSAKeyPair(): Promise<KeyPair> {
  console.log('Generating 2048-bit RSA key pair...');

  // Generate RSA key pair using jose
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', {
    modulusLength: 2048,
    extractable: true,
  });

  // Export keys to PEM format
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  const publicKeyPem = await jose.exportSPKI(publicKey);

  console.log('✓ Key pair generated successfully');

  return {
    privateKeyPem,
    publicKeyPem,
    certificate: '', // No longer needed - Okta accepts JWK directly
  };
}

/**
 * Save private key to file with secure permissions
 */
export async function savePrivateKey(privateKeyPem: string, filePath: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const dir = path.dirname(absolutePath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write private key to file
  fs.writeFileSync(absolutePath, privateKeyPem, { mode: 0o600 });

  console.log(`✓ Private key saved to: ${absolutePath}`);
  console.log(`  File permissions: 600 (owner read/write only)`);
}

/**
 * Check if private key file already exists
 */
export function privateKeyExists(filePath: string): boolean {
  return fs.existsSync(path.resolve(filePath));
}

/**
 * Load existing private key from file
 */
export function loadPrivateKey(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Private key file not found: ${absolutePath}`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

/**
 * Extract public key from private key PEM
 */
export async function extractPublicKeyFromPrivateKey(privateKeyPem: string): Promise<string> {
  const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');
  return await jose.exportSPKI(privateKey);
}
