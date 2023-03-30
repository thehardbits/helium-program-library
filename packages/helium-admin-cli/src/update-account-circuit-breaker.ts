import * as anchor from "@coral-xyz/anchor";
import { init } from "@helium/circuit-breaker-sdk";
import { PublicKey } from "@solana/web3.js";
import Squads from "@sqds/sdk";
import { BN } from "bn.js";
import os from "os";
import yargs from "yargs/yargs";
import { sendInstructionsOrCreateProposal, sendInstructionsOrSquads } from "./utils";

const { hideBin } = require("yargs/helpers");
const yarg = yargs(hideBin(process.argv)).options({
  wallet: {
    alias: "k",
    describe: "Anchor wallet keypair",
    default: `${os.homedir()}/.config/solana/id.json`,
  },
  url: {
    alias: "u",
    default: "http://127.0.0.1:8899",
    describe: "The solana url",
  },
  circuitBreaker: {
    type: "string",
    required: true,
    describe: "Circuit breaker account",
  },
  windowSizeSeconds: {
    type: "number",
  },
  threshold: {
    type: "number",
  },
  executeTransaction: {
    type: "boolean",
  },
  multisig: {
    type: "string",
    describe:
      "Address of the squads multisig to be authority. If not provided, your wallet will be the authority",
  },
  newAuthority: {
    type: "string",
  },
  authorityIndex: {
    type: "number",
    describe: "Authority index for squads. Defaults to 1",
    default: 1,
  },
});

export async function run(args: any = process.argv) {
  const argv = await yarg.argv;
  process.env.ANCHOR_WALLET = argv.wallet;
  process.env.ANCHOR_PROVIDER_URL = argv.url;
  anchor.setProvider(anchor.AnchorProvider.local(argv.url));

  const circuitBreakerKey = new PublicKey(argv.circuitBreaker);
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const circuitBreakerProgram = await init(provider);

  const instructions = [];
  const circuitBreaker =
    await circuitBreakerProgram.account.accountWindowedCircuitBreakerV0.fetch(
      circuitBreakerKey
    );
  instructions.push(
    await circuitBreakerProgram.methods
      .updateAccountWindowedBreakerV0({
        newAuthority: argv.newAuthority ? new PublicKey(argv.newAuthority) : circuitBreaker.authority,
        config: {
          windowSizeSeconds: argv.windowSizeSeconds
            ? new BN(argv.windowSizeSeconds)
            : circuitBreaker.config.windowSizeSeconds,
          thresholdType: circuitBreaker.config.thresholdType,
          threshold: argv.threshold
            ? new BN(argv.threshold)
            : circuitBreaker.config.threshold,
        },
      })
      .accounts({
        circuitBreaker: circuitBreakerKey,
        authority: circuitBreaker.authority,
      })
      .instruction()
  );

  const squads = Squads.endpoint(
    process.env.ANCHOR_PROVIDER_URL,
    provider.wallet
  );
  await sendInstructionsOrSquads({
    provider,
    instructions,
    executeTransaction: argv.executeTransaction,
    squads,
    multisig: argv.multisig ? new PublicKey(argv.multisig) : undefined,
    authorityIndex: argv.authorityIndex,
    signers: [],
  });
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit());