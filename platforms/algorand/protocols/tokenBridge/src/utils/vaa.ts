import {
  Chain,
  toChainId,
  TokenBridge,
  Network,
  serialize,
} from '@wormhole-foundation/connect-sdk';

import { keccak256 } from 'ethers';

import abi, {
  Algodv2,
  bigIntToBytes,
  makeApplicationCallTxnFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  SuggestedParams,
  getApplicationAddress,
  OnApplicationComplete,
  signLogicSigTransaction,
  Transaction,
  LogicSigAccount,
  encodeAddress,
} from 'algosdk';
import {
  MAX_BITS,
  BITS_PER_KEY,
  ZERO_PAD_BYTES,
  ALGO_VERIFY,
  ALGO_VERIFY_HASH,
  MAX_SIGS_PER_TXN,
} from './constants';
import { optin, assetOptinCheck, TransactionSignerPair } from './transaction';
import {
  uint8ArrayToHex,
  safeBigIntToNumber,
  textToHexString,
  hexToNativeAssetBigIntAlgorand,
  textToUint8Array,
  hexToUint8Array,
} from './conversions';
import { decodeLocalState } from './decode';

export type ParsedVAA = {
  version: number;
  index: number;
  siglen: number;
  signatures: Uint8Array;
  sigs: Uint8Array[];
  digest: Uint8Array;
  timestamp: number;
  nonce: number;
  chainRaw: string;
  chain: number;
  emitter: string;
  sequence: bigint;
  consistency: number;
  Meta:
    | 'Unknown'
    | 'TokenBridge'
    | 'TokenBridge RegisterChain'
    | 'TokenBridge UpgradeContract'
    | 'CoreGovernance'
    | 'TokenBridge Attest'
    | 'TokenBridge Transfer'
    | 'TokenBridge Transfer With Payload';
  module?: Uint8Array;
  action?: number;
  targetChain?: number;
  EmitterChainID?: number;
  targetEmitter?: Uint8Array;
  newContract?: Uint8Array;
  NewGuardianSetIndex?: number;
  Type?: number;
  Contract?: string;
  FromChain?: number;
  Decimals?: number;
  Symbol?: Uint8Array;
  Name?: Uint8Array;
  TokenId?: Uint8Array;
  Amount?: Uint8Array;
  ToAddress?: Uint8Array;
  ToChain?: number;
  Fee?: Uint8Array;
  FromAddress?: Uint8Array;
  Payload?: Uint8Array;
  Body?: Uint8Array;

  uri?: string;
};

class SubmitVAAState {
  vaaMap: ParsedVAA;
  accounts: string[];
  txs: TransactionSignerPair[];
  guardianAddr: string;

  constructor(
    vaaMap: ParsedVAA,
    accounts: string[],
    txs: TransactionSignerPair[],
    guardianAddr: string,
  ) {
    this.vaaMap = vaaMap;
    this.accounts = accounts;
    this.txs = txs;
    this.guardianAddr = guardianAddr;
  }
}

function extract3(buffer: Uint8Array, start: number, size: number) {
  return buffer.slice(start, start + size);
}

export function _parseVAAAlgorand(vaa: Uint8Array): ParsedVAA {
  let ret = {} as ParsedVAA;
  let buf = Buffer.from(vaa);
  ret.version = buf.readIntBE(0, 1);
  ret.index = buf.readIntBE(1, 4);
  ret.siglen = buf.readIntBE(5, 1);
  const siglen = ret.siglen;
  if (siglen) {
    ret.signatures = extract3(vaa, 6, siglen * 66);
  }
  const sigs: Uint8Array[] = [];
  for (let i = 0; i < siglen; i++) {
    const start = 6 + i * 66;
    const len = 66;
    const sigBuf = extract3(vaa, start, len);
    sigs.push(sigBuf);
  }
  ret.sigs = sigs;
  let off = siglen * 66 + 6;
  ret.digest = vaa.slice(off); // This is what is actually signed...
  ret.timestamp = buf.readIntBE(off, 4);
  off += 4;
  ret.nonce = buf.readIntBE(off, 4);
  off += 4;
  ret.chainRaw = Buffer.from(extract3(vaa, off, 2)).toString('hex');
  ret.chain = buf.readIntBE(off, 2);
  off += 2;
  ret.emitter = Buffer.from(extract3(vaa, off, 32)).toString('hex');
  off += 32;
  ret.sequence = buf.readBigUInt64BE(off);
  off += 8;
  ret.consistency = buf.readIntBE(off, 1);
  off += 1;

  ret.Meta = 'Unknown';

  if (
    !Buffer.compare(
      extract3(buf, off, 32),
      Buffer.from(
        '000000000000000000000000000000000000000000546f6b656e427269646765',
        'hex',
      ),
    )
  ) {
    ret.Meta = 'TokenBridge';
    ret.module = extract3(vaa, off, 32);
    off += 32;
    ret.action = buf.readIntBE(off, 1);
    off += 1;
    if (ret.action === 1) {
      ret.Meta = 'TokenBridge RegisterChain';
      ret.targetChain = buf.readIntBE(off, 2);
      off += 2;
      ret.EmitterChainID = buf.readIntBE(off, 2);
      off += 2;
      ret.targetEmitter = extract3(vaa, off, 32);
      off += 32;
    } else if (ret.action === 2) {
      ret.Meta = 'TokenBridge UpgradeContract';
      ret.targetChain = buf.readIntBE(off, 2);
      off += 2;
      ret.newContract = extract3(vaa, off, 32);
      off += 32;
    }
  } else if (
    !Buffer.compare(
      extract3(buf, off, 32),
      Buffer.from(
        '00000000000000000000000000000000000000000000000000000000436f7265',
        'hex',
      ),
    )
  ) {
    ret.Meta = 'CoreGovernance';
    ret.module = extract3(vaa, off, 32);
    off += 32;
    ret.action = buf.readIntBE(off, 1);
    off += 1;
    ret.targetChain = buf.readIntBE(off, 2);
    off += 2;
    ret.NewGuardianSetIndex = buf.readIntBE(off, 4);
  }

  //    ret.len=vaa.slice(off).length)
  //    ret.act=buf.readIntBE(off, 1))

  ret.Body = vaa.slice(off);

  if (vaa.slice(off).length === 100 && buf.readIntBE(off, 1) === 2) {
    ret.Meta = 'TokenBridge Attest';
    ret.Type = buf.readIntBE(off, 1);
    off += 1;
    ret.Contract = uint8ArrayToHex(extract3(vaa, off, 32));
    off += 32;
    ret.FromChain = buf.readIntBE(off, 2);
    off += 2;
    ret.Decimals = buf.readIntBE(off, 1);
    off += 1;
    ret.Symbol = extract3(vaa, off, 32);
    off += 32;
    ret.Name = extract3(vaa, off, 32);
  }

  if (vaa.slice(off).length === 133 && buf.readIntBE(off, 1) === 1) {
    ret.Meta = 'TokenBridge Transfer';
    ret.Type = buf.readIntBE(off, 1);
    off += 1;
    ret.Amount = extract3(vaa, off, 32);
    off += 32;
    ret.Contract = uint8ArrayToHex(extract3(vaa, off, 32));
    off += 32;
    ret.FromChain = buf.readIntBE(off, 2);
    off += 2;
    ret.ToAddress = extract3(vaa, off, 32);
    off += 32;
    ret.ToChain = buf.readIntBE(off, 2);
    off += 2;
    ret.Fee = extract3(vaa, off, 32);
  }

  if (off >= buf.length) {
    return ret;
  }
  if (buf.readIntBE(off, 1) === 3) {
    ret.Meta = 'TokenBridge Transfer With Payload';
    ret.Type = buf.readIntBE(off, 1);
    off += 1;
    ret.Amount = extract3(vaa, off, 32);
    off += 32;
    ret.Contract = uint8ArrayToHex(extract3(vaa, off, 32));
    off += 32;
    ret.FromChain = buf.readIntBE(off, 2);
    off += 2;
    ret.ToAddress = extract3(vaa, off, 32);
    off += 32;
    ret.ToChain = buf.readIntBE(off, 2);
    off += 2;
    ret.FromAddress = extract3(vaa, off, 32);
    off += 32;
    ret.Payload = vaa.slice(off);
  }

  return ret;
}

/**
 * This function is used to check if a VAA has been redeemed by looking at a specific bit.
 * @param client AlgodV2 client
 * @param appId Application Id
 * @param addr Wallet address. Someone has to pay for this.
 * @param seq The sequence number of the redemption
 * @returns true, if the bit was set and VAA was redeemed, false otherwise.
 */
export async function checkBitsSet(
  client: Algodv2,
  appId: bigint,
  addr: string,
  seq: bigint,
): Promise<boolean> {
  let retval: boolean = false;
  let appState: any[] = [];
  const acctInfo = await client.accountInformation(addr).do();
  const als = acctInfo['apps-local-state'];
  als.forEach((app: any) => {
    if (BigInt(app['id']) === appId) {
      appState = app['key-value'];
    }
  });
  if (appState.length === 0) {
    return retval;
  }

  const BIG_MAX_BITS: bigint = BigInt(MAX_BITS);
  const BIG_EIGHT: bigint = BigInt(8);
  // Start on a MAX_BITS boundary
  const start: bigint = (seq / BIG_MAX_BITS) * BIG_MAX_BITS;
  // beg should be in the range [0..MAX_BITS]
  const beg: number = safeBigIntToNumber(seq - start);
  // s should be in the range [0..15]
  const s: number = Math.floor(beg / BITS_PER_KEY);
  const b: number = Math.floor((beg - s * BITS_PER_KEY) / 8);

  const key = Buffer.from(bigIntToBytes(s, 1)).toString('base64');
  appState.forEach((kv) => {
    if (kv['key'] === key) {
      const v = Buffer.from(kv['value']['bytes'], 'base64');
      const bt = 1 << safeBigIntToNumber(seq % BIG_EIGHT);
      retval = (v[b] & bt) != 0;
      return;
    }
  });
  return retval;
}

/**
 * Submits just the header of the VAA
 * @param client AlgodV2 client
 * @param bridgeId Application ID of the core bridge
 * @param vaa The VAA (Just the header is used)
 * @param senderAddr Sending account address
 * @param appid Application ID
 * @returns Current VAA state
 */
export async function submitVAAHeader(
  client: Algodv2,
  bridgeId: bigint,
  vaa: TokenBridge.VAA<'Transfer' | 'TransferWithPayload' | 'AttestMeta'>,
  senderAddr: string,
  appid: bigint,
): Promise<SubmitVAAState> {
  // A lot of our logic here depends on parseVAA and knowing what the payload is..
  const parsedVAA = _parseVAAAlgorand(serialize(vaa));
  const seq: bigint = parsedVAA.sequence / BigInt(MAX_BITS);
  const chainRaw: string = parsedVAA.chainRaw; // TODO: this needs to be a hex string
  const em: string = parsedVAA.emitter; // TODO: this needs to be a hex string
  const index: number = parsedVAA.index;

  let txs: TransactionSignerPair[] = [];
  // "seqAddr"
  const { addr: seqAddr, txs: seqOptInTxs } = await optin(
    client,
    senderAddr,
    appid,
    seq,
    chainRaw + em,
  );
  txs.push(...seqOptInTxs);
  const guardianPgmName = textToHexString('guardian');

  // And then the signatures to help us verify the vaa_s
  // "guardianAddr"
  const { addr: guardianAddr, txs: guardianOptInTxs } = await optin(
    client,
    senderAddr,
    bridgeId,
    BigInt(index),
    guardianPgmName,
  );
  txs.push(...guardianOptInTxs);
  let accts: string[] = [seqAddr, guardianAddr];

  // When we attest for a new token, we need some place to store the info... later we will need to
  // mirror the other way as well
  const keys: Uint8Array = await decodeLocalState(
    client,
    bridgeId,
    guardianAddr,
  );

  const params: SuggestedParams = await client.getTransactionParams().do();

  // We don't pass the entire payload in but instead just pass it pre digested.  This gets around size
  // limitations with lsigs AND reduces the cost of the entire operation on a congested network by reducing the
  // bytes passed into the transaction
  // This is a 2 pass digest
  const digest = keccak256(keccak256(parsedVAA.digest)).slice(2);

  // How many signatures can we process in a single txn... we can do 6!
  // There are likely upwards of 19 signatures.  So, we ned to split things up
  const numSigs: number = parsedVAA.siglen;
  let numTxns: number = Math.floor(numSigs / MAX_SIGS_PER_TXN) + 1;

  const SIG_LEN: number = 66;
  const BSIZE: number = SIG_LEN * MAX_SIGS_PER_TXN;
  const signatures: Uint8Array = parsedVAA.signatures;
  const verifySigArg: Uint8Array = textToUint8Array('verifySigs');
  const lsa = new LogicSigAccount(ALGO_VERIFY);
  for (let nt = 0; nt < numTxns; nt++) {
    let sigs: Uint8Array = signatures.slice(nt * BSIZE);
    if (sigs.length > BSIZE) {
      sigs = sigs.slice(0, BSIZE);
    }

    // The keyset is the set of guardians that correspond
    // to the current set of signatures in this loop.
    // Each signature in 20 bytes and comes from decodeLocalState()
    const GuardianKeyLen: number = 20;
    const numSigsThisTxn = sigs.length / SIG_LEN;
    let arraySize: number = numSigsThisTxn * GuardianKeyLen;
    let keySet: Uint8Array = new Uint8Array(arraySize);
    for (let i = 0; i < numSigsThisTxn; i++) {
      // The first byte of the sig is the relative index of that signature in the signatures array
      // Use that index to get the appropriate guardian key
      const idx = sigs[i * SIG_LEN];
      const key = keys.slice(
        idx * GuardianKeyLen + 1,
        (idx + 1) * GuardianKeyLen + 1,
      );
      keySet.set(key, i * 20);
    }

    const appTxn = makeApplicationCallTxnFromObject({
      appArgs: [verifySigArg, sigs, keySet, hexToUint8Array(digest)],
      accounts: accts,
      appIndex: safeBigIntToNumber(bridgeId),
      from: ALGO_VERIFY_HASH,
      onComplete: OnApplicationComplete.NoOpOC,
      suggestedParams: params,
    });
    appTxn.fee = 0;
    txs.push({
      tx: appTxn,
      signer: {
        addr: lsa.address(),
        signTxn: (txn: Transaction) =>
          Promise.resolve(signLogicSigTransaction(txn, lsa).blob),
      },
    });
  }
  const appTxn = makeApplicationCallTxnFromObject({
    appArgs: [textToUint8Array('verifyVAA'), serialize(vaa)],
    accounts: accts,
    appIndex: safeBigIntToNumber(bridgeId),
    from: senderAddr,
    onComplete: OnApplicationComplete.NoOpOC,
    suggestedParams: params,
  });
  appTxn.fee = appTxn.fee * (1 + numTxns);
  txs.push({ tx: appTxn, signer: null });

  return new SubmitVAAState(parsedVAA, accts, txs, guardianAddr);
}

/**
 * Submits the VAA to the application
 * @param client AlgodV2 client
 * @param tokenBridgeId Application ID of the token bridge
 * @param bridgeId Application ID of the core bridge
 * @param vaa The VAA to be submitted
 * @param senderAddr Sending account address
 * @returns Confirmation log
 */
export async function _submitVAAAlgorand(
  client: Algodv2,
  tokenBridgeId: bigint,
  bridgeId: bigint,
  vaa: TokenBridge.VAA<'Transfer' | 'TransferWithPayload'>,
  senderAddr: string,
  chain: Chain,
  network: Network,
): Promise<TransactionSignerPair[]> {
  let sstate = await submitVAAHeader(
    client,
    bridgeId,
    vaa,
    senderAddr,
    tokenBridgeId,
  );

  let parsedVAA = _parseVAAAlgorand(serialize(vaa));
  let accts = sstate.accounts;
  let txs = sstate.txs;

  // If this happens to be setting up a new guardian set, we probably need it as well...
  if (
    parsedVAA.Meta === 'CoreGovernance' &&
    parsedVAA.action === 2 &&
    parsedVAA.NewGuardianSetIndex !== undefined
  ) {
    const ngsi = parsedVAA.NewGuardianSetIndex;
    const guardianPgmName = textToHexString('guardian');
    // "newGuardianAddr"
    const { addr: newGuardianAddr, txs: newGuardianOptInTxs } = await optin(
      client,
      senderAddr,
      bridgeId,
      BigInt(ngsi),
      guardianPgmName,
    );
    accts.push(newGuardianAddr);
    txs.unshift(...newGuardianOptInTxs);
  }

  // When we attest for a new token, we need some place to store the info... later we will need to
  // mirror the other way as well
  const meta = parsedVAA.Meta;
  let chainAddr: string = '';
  if (
    (meta === 'TokenBridge Attest' ||
      meta === 'TokenBridge Transfer' ||
      meta === 'TokenBridge Transfer With Payload') &&
    parsedVAA.Contract !== undefined
  ) {
    if (parsedVAA.FromChain !== toChainId(chain) && parsedVAA.FromChain) {
      // "TokenBridge chainAddr"
      const result = await optin(
        client,
        senderAddr,
        tokenBridgeId,
        BigInt(parsedVAA.FromChain),
        parsedVAA.Contract,
      );
      chainAddr = result.addr;
      txs.unshift(...result.txs);
    } else {
      const assetId = hexToNativeAssetBigIntAlgorand(parsedVAA.Contract);
      // "TokenBridge native chainAddr"
      const result = await optin(
        client,
        senderAddr,
        tokenBridgeId,
        assetId,
        textToHexString('native'),
      );
      chainAddr = result.addr;
      txs.unshift(...result.txs);
    }
    accts.push(chainAddr);
  }

  const params: SuggestedParams = await client.getTransactionParams().do();

  if (meta === 'CoreGovernance') {
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        appArgs: [textToUint8Array('governance'), serialize(vaa)],
        accounts: accts,
        appIndex: safeBigIntToNumber(bridgeId),
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        appArgs: [textToUint8Array('nop'), bigIntToBytes(5, 8)],
        appIndex: safeBigIntToNumber(bridgeId),
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });
  }
  if (
    meta === 'TokenBridge RegisterChain' ||
    meta === 'TokenBridge UpgradeContract'
  ) {
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        appArgs: [textToUint8Array('governance'), serialize(vaa)],
        accounts: accts,
        appIndex: safeBigIntToNumber(tokenBridgeId),
        foreignApps: [safeBigIntToNumber(bridgeId)],
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });
  }

  if (meta === 'TokenBridge Attest') {
    let asset: Uint8Array = await decodeLocalState(
      client,
      BigInt(tokenBridgeId),
      chainAddr,
    );
    let foreignAssets: number[] = [];
    if (asset.length > 8) {
      const tmp = Buffer.from(asset.slice(0, 8));
      foreignAssets.push(safeBigIntToNumber(tmp.readBigUInt64BE(0)));
    }
    txs.push({
      tx: makePaymentTxnWithSuggestedParamsFromObject({
        from: senderAddr,
        to: chainAddr,
        amount: 100000,
        suggestedParams: params,
      }),
      signer: null,
    });
    let buf: Uint8Array = new Uint8Array(1);
    buf[0] = 0x01;
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        appArgs: [textToUint8Array('nop'), buf],
        appIndex: safeBigIntToNumber(tokenBridgeId),
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });

    buf = new Uint8Array(1);
    buf[0] = 0x02;
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        appArgs: [textToUint8Array('nop'), buf],
        appIndex: safeBigIntToNumber(tokenBridgeId),
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });

    txs.push({
      tx: makeApplicationCallTxnFromObject({
        accounts: accts,
        appArgs: [textToUint8Array('receiveAttest'), serialize(vaa)],
        appIndex: safeBigIntToNumber(tokenBridgeId),
        foreignAssets: foreignAssets,
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });
    txs[txs.length - 1].tx.fee = txs[txs.length - 1].tx.fee * 2;
  }

  if (
    (meta === 'TokenBridge Transfer' ||
      meta === 'TokenBridge Transfer With Payload') &&
    parsedVAA.Contract !== undefined
  ) {
    let foreignAssets: number[] = [];
    let a: number = 0;
    if (parsedVAA.FromChain !== toChainId(chain)) {
      let asset = await decodeLocalState(
        client,
        BigInt(tokenBridgeId),
        chainAddr,
      );

      if (asset.length > 8) {
        const tmp = Buffer.from(asset.slice(0, 8));
        a = safeBigIntToNumber(tmp.readBigUInt64BE(0));
      }
    } else {
      a = parseInt(parsedVAA.Contract, 16);
    }

    // The receiver needs to be optin in to receive the coins... Yeah, the relayer pays for this

    let aid = 0;
    let addr = '';

    if (parsedVAA.ToAddress !== undefined) {
      if (parsedVAA.ToChain === 8 && parsedVAA.Type === 3) {
        aid = Number(
          hexToNativeAssetBigIntAlgorand(uint8ArrayToHex(parsedVAA.ToAddress)),
        );
        addr = getApplicationAddress(aid);
      } else {
        addr = encodeAddress(parsedVAA.ToAddress);
      }
    }

    if (a !== 0) {
      foreignAssets.push(a);
      if (!(await assetOptinCheck(client, BigInt(a), addr))) {
        if (senderAddr != addr) {
          throw new Error(
            'cannot ASA optin for somebody else (asset ' + a.toString() + ')',
          );
        }

        txs.unshift({
          tx: makeAssetTransferTxnWithSuggestedParamsFromObject({
            amount: 0,
            assetIndex: a,
            from: senderAddr,
            suggestedParams: params,
            to: senderAddr,
          }),
          signer: null,
        });
      }
    }
    accts.push(addr);
    txs.push({
      tx: makeApplicationCallTxnFromObject({
        accounts: accts,
        appArgs: [textToUint8Array('completeTransfer'), serialize(vaa)],
        appIndex: safeBigIntToNumber(tokenBridgeId),
        foreignAssets: foreignAssets,
        from: senderAddr,
        onComplete: OnApplicationComplete.NoOpOC,
        suggestedParams: params,
      }),
      signer: null,
    });

    // We need to cover the inner transactions
    if (
      parsedVAA.Fee !== undefined &&
      Buffer.compare(parsedVAA.Fee, Buffer.from(ZERO_PAD_BYTES, 'hex')) === 0
    )
      txs[txs.length - 1].tx.fee = txs[txs.length - 1].tx.fee * 2;
    else txs[txs.length - 1].tx.fee = txs[txs.length - 1].tx.fee * 3;

    if (meta === 'TokenBridge Transfer With Payload') {
      txs[txs.length - 1].tx.appForeignApps = [aid];

      let m = abi.ABIMethod.fromSignature('portal_transfer(byte[])byte[]');

      txs.push({
        tx: makeApplicationCallTxnFromObject({
          appArgs: [
            m.getSelector(),
            (m.args[0].type as abi.ABIType).encode(serialize(vaa)),
          ],
          appIndex: aid,
          foreignAssets: foreignAssets,
          from: senderAddr,
          onComplete: OnApplicationComplete.NoOpOC,
          suggestedParams: params,
        }),
        signer: null,
      });
    }
  }

  return txs;
}
