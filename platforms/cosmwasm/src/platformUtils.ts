import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import {
  Balances,
  ChainName,
  Network,
  PlatformToChains,
  SignedTx,
  TokenId,
  TxHash,
  chainToPlatform,
  nativeChainAddress,
  nativeDecimals,
  chainIds,
} from "@wormhole-foundation/connect-sdk";
import { CosmwasmAddress } from "./address";
import { IBC_TRANSFER_PORT, chainToNativeDenoms } from "./constants";
import { CosmwasmPlatform } from "./platform";
import { AnyCosmwasmAddress } from "./types";

/**
 * @category CosmWasm
 */
// Provides runtime concrete value
export module CosmwasmUtils {
  export function nativeTokenId(chain: ChainName): TokenId {
    if (!isSupportedChain(chain)) throw new Error(`invalid chain for CosmWasm: ${chain}`);
    return nativeChainAddress([chain, getNativeDenom(chain)]);
  }

  export function isSupportedChain(chain: ChainName): boolean {
    const platform = chainToPlatform(chain);
    return platform === CosmwasmPlatform.platform;
  }

  export function isNativeTokenId(chain: ChainName, tokenId: TokenId): boolean {
    if (!isSupportedChain(chain)) return false;
    if (tokenId.chain !== chain) return false;
    const native = nativeTokenId(chain);
    return native == tokenId;
  }

  export async function getDecimals(
    chain: ChainName,
    rpc: CosmWasmClient,
    token: AnyCosmwasmAddress | "native",
  ): Promise<bigint> {
    if (token === "native") return nativeDecimals(CosmwasmPlatform.platform);

    const addrStr = new CosmwasmAddress(token).toString();
    const { decimals } = await rpc.queryContractSmart(addrStr, {
      token_info: {},
    });
    return decimals;
  }

  export async function getBalance(
    chain: ChainName,
    rpc: CosmWasmClient,
    walletAddress: string,
    token: AnyCosmwasmAddress | "native",
  ): Promise<bigint | null> {
    if (token === "native") {
      const { amount } = await rpc.getBalance(walletAddress, getNativeDenom(chain));
      return BigInt(amount);
    }

    const addrStr = new CosmwasmAddress(token).toString();
    const { amount } = await rpc.getBalance(walletAddress, addrStr);
    return BigInt(amount);
  }

  export async function getBalances(
    chain: ChainName,
    rpc: CosmWasmClient,
    walletAddress: string,
    tokens: (AnyCosmwasmAddress | "native")[],
  ): Promise<Balances> {
    const client = CosmwasmPlatform.getQueryClient(rpc);
    const allBalances = await client.bank.allBalances(walletAddress);
    const balancesArr = tokens.map((token) => {
      const address =
        token === "native" ? getNativeDenom(chain) : new CosmwasmAddress(token).toString();
      const balance = allBalances.find((balance) => balance.denom === address);
      const balanceBigInt = balance ? BigInt(balance.amount) : null;
      return { [address]: balanceBigInt };
    });

    return balancesArr.reduce((obj, item) => Object.assign(obj, item), {});
  }

  export function getNativeDenom(chain: ChainName): string {
    return chainToNativeDenoms(
      CosmwasmPlatform.network,
      chain as PlatformToChains<CosmwasmPlatform.Type>,
    );
  }

  export function isNativeDenom(chain: ChainName, denom: string): boolean {
    return denom === getNativeDenom(chain);
  }

  export async function sendWait(
    chain: ChainName,
    rpc: CosmWasmClient,
    stxns: SignedTx[],
  ): Promise<TxHash[]> {
    const txhashes: TxHash[] = [];
    for (const stxn of stxns) {
      const result = await rpc.broadcastTx(stxn);
      if (result.code !== 0)
        throw new Error(`Error sending transaction (${result.transactionHash}): ${result.rawLog}`);
      txhashes.push(result.transactionHash);
    }
    return txhashes;
  }

  export async function getCurrentBlock(rpc: CosmWasmClient): Promise<number> {
    return rpc.getHeight();
  }

  export function chainFromChainId(
    chainMoniker: string,
  ): [Network, PlatformToChains<CosmwasmPlatform.Type>] {
    const networkChainPair = chainIds.getNetworkAndChainName(
      CosmwasmPlatform.platform,
      chainMoniker,
    );

    if (networkChainPair === undefined) throw new Error(`Unknown Cosmwasm chainId ${chainMoniker}`);

    const [network, chain] = networkChainPair;
    return [network, chain];
  }

  export async function chainFromRpc(
    rpc: CosmWasmClient,
  ): Promise<[Network, PlatformToChains<CosmwasmPlatform.Type>]> {
    const chainId = await rpc.getChainId();
    return chainFromChainId(chainId);
  }

  export async function getCounterpartyChannel(
    sourceChannel: string,
    rpc: CosmWasmClient,
  ): Promise<string | null> {
    const queryClient = CosmwasmPlatform.getQueryClient(rpc);
    const conn = await queryClient.ibc.channel.channel(IBC_TRANSFER_PORT, sourceChannel);
    return conn.channel?.counterparty?.channelId ?? null;
  }
}
