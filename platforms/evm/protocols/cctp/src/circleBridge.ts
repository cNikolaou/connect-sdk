import {
  ChainAddress,
  CircleBridge,
  CircleChainName,
  CircleNetwork,
  CircleTransferMessage,
  Network,
  UnsignedTransaction,
  circleChainId,
  deserializeCircleMessage,
  nativeChainAddress,
  toCircleChainName,
  usdcContract,
  encoding,
  Contracts,
  ChainsConfig,
  chainIds,
} from '@wormhole-foundation/connect-sdk';

import { MessageTransmitter, TokenMessenger } from './ethers-contracts';

import { LogDescription, Provider, TransactionRequest } from 'ethers';
import {
  EvmAddress,
  EvmPlatform,
  AnyEvmAddress,
  EvmChainName,
  addChainId,
  addFrom,
  EvmUnsignedTransaction,
} from '@wormhole-foundation/connect-sdk-evm';
import { ethers_contracts } from '.';
//https://github.com/circlefin/evm-cctp-contracts

export class EvmCircleBridge implements CircleBridge<'Evm'> {
  readonly chainId: bigint;
  readonly msgTransmitter: MessageTransmitter.MessageTransmitter;
  readonly tokenMessenger: TokenMessenger.TokenMessenger;

  readonly tokenEventHash: string;
  readonly messageSentEventHash: string;
  readonly messageReceivedEventHash: string;

  private constructor(
    readonly network: Network,
    readonly chain: EvmChainName,
    readonly provider: Provider,
    readonly contracts: Contracts,
  ) {
    if (network === 'Devnet')
      throw new Error('CircleBridge not supported on Devnet');

    this.chainId = chainIds.evmNetworkChainToEvmChainId(network, chain);

    const msgTransmitterAddress = contracts.cctp?.messageTransmitter;
    if (!msgTransmitterAddress)
      throw new Error(
        `Circle Messenge Transmitter contract for domain ${chain} not found`,
      );

    this.msgTransmitter = ethers_contracts.MessageTransmitter__factory.connect(
      msgTransmitterAddress,
      provider,
    );

    const tokenMessengerAddress = contracts.cctp?.tokenMessenger;
    if (!tokenMessengerAddress)
      throw new Error(
        `Circle Token Messenger contract for domain ${chain} not found`,
      );

    this.tokenMessenger = ethers_contracts.TokenMessenger__factory.connect(
      tokenMessengerAddress,
      provider,
    );

    this.tokenEventHash =
      this.tokenMessenger.getEvent('DepositForBurn').fragment.topicHash;

    this.messageSentEventHash =
      this.msgTransmitter.getEvent('MessageSent').fragment.topicHash;

    this.messageReceivedEventHash =
      this.msgTransmitter.getEvent('MessageReceived').fragment.topicHash;
  }

  static async fromRpc(
    provider: Provider,
    config: ChainsConfig,
  ): Promise<EvmCircleBridge> {
    const [network, chain] = await EvmPlatform.chainFromRpc(provider);
    return new EvmCircleBridge(
      network,
      chain,
      provider,
      config[chain]!.contracts!,
    );
  }

  async *redeem(
    sender: AnyEvmAddress,
    message: string,
    attestation: string,
  ): AsyncGenerator<UnsignedTransaction> {
    const senderAddr = new EvmAddress(sender).toString();

    const txReq = await this.msgTransmitter.receiveMessage.populateTransaction(
      encoding.hex.decode(message),
      encoding.hex.decode(attestation),
    );

    yield this.createUnsignedTx(
      addFrom(txReq, senderAddr),
      'CircleBridge.redeem',
    );
  }
  //alternative naming: initiateTransfer
  async *transfer(
    sender: AnyEvmAddress,
    recipient: ChainAddress,
    amount: bigint,
  ): AsyncGenerator<EvmUnsignedTransaction> {
    const senderAddr = new EvmAddress(sender).toString();
    const recipientAddress = recipient.address
      .toUniversalAddress()
      .toUint8Array();

    const tokenAddr = usdcContract(
      this.network as CircleNetwork,
      this.chain as CircleChainName,
    );

    const tokenContract = EvmPlatform.getTokenImplementation(
      this.provider,
      tokenAddr,
    );

    const allowance = await tokenContract.allowance(
      senderAddr,
      this.tokenMessenger.target,
    );

    if (allowance < amount) {
      const txReq = await tokenContract.approve.populateTransaction(
        this.tokenMessenger.target,
        amount,
      );
      yield this.createUnsignedTx(
        addFrom(txReq, senderAddr),
        'ERC20.approve of CircleBridge',
        false,
      );
    }

    const txReq = await this.tokenMessenger.depositForBurn.populateTransaction(
      amount,
      circleChainId(recipient.chain as CircleChainName),
      recipientAddress,
      tokenAddr,
    );

    yield this.createUnsignedTx(
      addFrom(txReq, senderAddr),
      'CircleBridge.transfer',
    );
  }

  // Fetch the transaction logs and parse the CircleTransferMessage
  async parseTransactionDetails(txid: string): Promise<CircleTransferMessage> {
    const receipt = await this.provider.getTransactionReceipt(txid);
    if (!receipt) throw new Error(`No receipt for ${txid} on ${this.chain}`);

    const messageLogs = receipt.logs
      .filter((log) => log.topics[0] === this.messageSentEventHash)
      .map((messageLog) => {
        const { topics, data } = messageLog;
        return this.msgTransmitter.interface.parseLog({
          topics: topics.slice(),
          data: data,
        });
      })
      .filter((l): l is LogDescription => !!l);

    if (messageLogs.length === 0)
      throw new Error(
        `No log message for message transmitter found in ${txid}`,
      );

    // just taking the first one here, will there ever be >1?
    if (messageLogs.length > 1)
      console.error(
        `Expected 1 event to be found for transaction, got>${messageLogs.length}}`,
      );

    const [messageLog] = messageLogs;
    const { message } = messageLog.args;
    const [circleMsg, hash] = deserializeCircleMessage(
      encoding.hex.decode(message),
    );
    const { payload: body } = circleMsg;

    const xferSender = body.messageSender;
    const xferReceiver = body.mintRecipient;

    const sendChain = toCircleChainName(circleMsg.sourceDomain);
    const rcvChain = toCircleChainName(circleMsg.destinationDomain);

    const token = nativeChainAddress([sendChain, body.burnToken]);

    return {
      from: nativeChainAddress([sendChain, xferSender]),
      to: nativeChainAddress([rcvChain, xferReceiver]),
      token: token,
      amount: body.amount,
      messageId: { message, hash },
    };
  }

  private createUnsignedTx(
    txReq: TransactionRequest,
    description: string,
    parallelizable: boolean = false,
  ): EvmUnsignedTransaction {
    return new EvmUnsignedTransaction(
      addChainId(txReq, this.chainId),
      this.network,
      this.chain,
      description,
      parallelizable,
    );
  }
}
