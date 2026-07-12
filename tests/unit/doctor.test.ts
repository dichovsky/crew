import { describe, expect, it } from 'vitest';
import { isNetworkFsType } from '../../src/doctor.js';

describe('isNetworkFsType', () => {
  it('classifies known network filesystem magic numbers', () => {
    expect(isNetworkFsType(0x6969)).toBe(true); // NFS
    expect(isNetworkFsType(0xff534d42)).toBe(true); // CIFS/SMB
    expect(isNetworkFsType(0xfe534d42)).toBe(true); // SMB2
  });

  it('treats local filesystem types as not-network', () => {
    expect(isNetworkFsType(0xef53)).toBe(false); // ext2/3/4
    expect(isNetworkFsType(26)).toBe(false); // common macOS statfs type
    expect(isNetworkFsType(0)).toBe(false);
  });
});
