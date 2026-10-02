// Minimal ABI + encoding helpers. Hand-rolled so the kit has no ABI dependency
// and so every selector it uses is visible and auditable in one file.
// viem supplies Ethereum's keccak-256 (node:crypto only ships NIST SHA3, which
// produces different selectors and would silently mis-encode every call).
import { keccak256, toBytes } from 'viem/utils';

export const ERC721_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenByIndex', stateMutability: 'view', inputs: [{ name: 'index', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }] },
];

export const ERC1155_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable', inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
  { type: 'event', name: 'TransferSingle', inputs: [{ name: 'operator', type: 'address', indexed: true }, { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'id', type: 'uint256', indexed: false }, { name: 'value', type: 'uint256', indexed: false }] },
];

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

export const COMMON_MINT_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'mint', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'mint', stateMutability: 'payable', inputs: [{ name: 'to', type: 'address' }, { name: 'quantity', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'mintPublic', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'publicMint', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'purchase', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'mintPrice', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxPerWallet', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxPerTx', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalMinted', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'maxSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'saleIsActive', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isActive', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

/**
 * keccak256 -> 4-byte selector, as a 0x-prefixed hex string.
 * viem's toBytes() returns a Uint8Array whose .toString() is "35,184,..."
 * — that comma form must never reach an encoder, so build the hex explicitly.
 */
export function selector(signature) {
  const bytes = toBytes(keccak256(signature));
  let hex = '0x';
  for (const b of bytes.slice(0, 4)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export function encodeAddress(addr) {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export function encodeUint(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

export function encodeCall(signature, args = []) {
  const types = signature.slice(signature.indexOf('(') + 1, signature.lastIndexOf(')')).split(',').map((s) => s.trim()).filter(Boolean);
  // selector() is 0x-prefixed; strip it so calldata is not "0x0x...".
  let data = '0x' + selector(signature).replace(/^0x/, '');
  types.forEach((type, i) => {
    if (type === 'address') data += encodeAddress(args[i]);
    else if (type.startsWith('uint') || type.startsWith('int')) data += encodeUint(args[i]);
    else if (type === 'bool') data += encodeUint(args[i] ? 1 : 0);
    else if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) {
      // Fixed-size byte types are left-aligned (high-order bytes), not right-padded.
      const size = Number(type.slice(5));
      const hex = String(args[i]).replace(/^0x/, '').slice(0, size * 2);
      data += hex.padEnd(64, '0');
    }
    else if (type === 'bytes32') data += String(args[i]).replace(/^0x/, '').padEnd(64, '0');
    else if (type === 'bytes') {
      const hex = String(args[i]).replace(/^0x/, '');
      data += encodeUint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 2 / 32) * 64, '0');
    } else throw new Error(`unsupported ABI type in ${signature}: ${type}`);
  });
  return data;
}

/** Decode a single `address` return (ownerOf / owner). */
export function decodeAddress(hex) {
  if (!hex || hex === '0x') return null;
  return '0x' + hex.replace(/^0x/, '').slice(24, 64);
}

export function decodeUint(hex) {
  // A contract without the function returns null (or 0x); treat both as absent
  // rather than letting BigInt(null) throw deep inside a caller.
  if (hex == null || hex === '0x' || hex === '') return null;
  return BigInt(hex);
}

export function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const body = hex.replace(/^0x/, '');
    const offset = Number(BigInt('0x' + body.slice(0, 64)));
    const len = Number(BigInt('0x' + body.slice(offset * 2, offset * 2 + 64)));
    const bytes = body.slice(offset * 2 + 128, offset * 2 + 128 + len * 2);
    return Buffer.from(bytes, 'hex').toString('utf8');
  } catch {
    return '';
  }
}

export function formatUnits(v, decimals = 18) {
  // Guard: absent values are common (a contract with no price getter). Report
  // them as "unknown" rather than letting BigInt(null) abort a whole scan.
  if (v == null) return 'unknown';
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function parseUnits(value, decimals = 18) {
  const [w, f = ''] = String(value).split('.');
  return BigInt((w || '0') + f.padEnd(decimals, '0').slice(0, decimals));
}

export function checksumAddress(addr) {
  return addr; // RPCs accept lowercase; checksumming is cosmetic only.
}
