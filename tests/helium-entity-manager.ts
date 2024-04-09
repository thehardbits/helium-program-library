import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair as HeliumKeypair } from "@helium/crypto";
import { init as initDataCredits } from "@helium/data-credits-sdk";
import { init as initHeliumSubDaos } from "@helium/helium-sub-daos-sdk";
import { init as initConversionEscrow } from "@helium/conversion-escrow-sdk";
import { notEmittedKey, init as initBurn } from "@helium/no-emit-sdk";
import {
  Asset,
  AssetProof,
  HELIUM_COMMON_LUT,
  HNT_PYTH_PRICE_FEED,
  MOBILE_PYTH_PRICE_FEED,
  SOL_PYTH_PRICE_FEED,
  USDC_PYTH_PRICE_FEED,
  createAtaAndMint,
  createMint,
  createMintInstructions,
  proofArgsAndAccounts,
  sendInstructions,
  toBN,
  toVersionedTx,
} from "@helium/spl-utils";
import { AddGatewayV1 } from "@helium/transactions";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import chai from "chai";
import {
  dataOnlyConfigKey,
  init as initHeliumEntityManager,
  iotInfoKey,
  onboardIotHotspot,
  onboardMobileHotspot,
  updateIotMetadata,
  updateMobileMetadata,
} from "../packages/helium-entity-manager-sdk/src";
import { DataCredits } from "../target/types/data_credits";
import { HeliumEntityManager } from "../target/types/helium_entity_manager";
import { NoEmit } from "../target/types/no_emit";
import { HeliumSubDaos } from "../target/types/helium_sub_daos";
import { initTestDao, initTestSubdao } from "./utils/daos";
import {
  DC_FEE,
  ensureDCIdl,
  ensureHSDIdl,
  ensureHEMIdl,
  initTestDataCredits,
  initTestMaker,
  initTestRewardableEntityConfig,
  MAKER_STAKING_FEE,
  ensureConversionEscrowIdl,
} from "./utils/fixtures";
// @ts-ignore
import bs58 from "bs58";
const { expect } = chai;
// @ts-ignore
import { helium } from "@helium/proto";
// @ts-ignore
import axios from "axios";

import {
  MerkleTree,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  getConcurrentMerkleTreeAccountSize,
} from "@solana/spl-account-compression";
import { BN } from "bn.js";
import chaiAsPromised from "chai-as-promised";
import { createMockCompression } from "./utils/compression";
import { loadKeypair } from "./utils/solana";
import { keyToAssetKey, mobileInfoKey, payMobileVoucherDc, payMobileVoucherMobile } from "@helium/helium-entity-manager-sdk";
import { program } from "@coral-xyz/anchor/dist/cjs/native/system";
import { ConversionEscrow } from "../target/types/conversion_escrow";
import { parsePriceData } from "@pythnetwork/client";

chai.use(chaiAsPromised);

describe("helium-entity-manager", () => {
  anchor.setProvider(anchor.AnchorProvider.local("http://127.0.0.1:8899"));

  let dcProgram: Program<DataCredits>;
  let hsdProgram: Program<HeliumSubDaos>;
  let hemProgram: Program<HeliumEntityManager>;
  let conversionEscrowProgram: Program<ConversionEscrow>;
  let noEmitProgram: Program<NoEmit>;

  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const me = provider.wallet.publicKey;
  const eccVerifier = loadKeypair(__dirname + "/keypairs/verifier-test.json");
  let dao: PublicKey;
  let subDao: PublicKey;
  let dcMint: PublicKey;
  let hntMint: PublicKey;
  let dntMint: PublicKey;
  let activeDeviceAuthority: Keypair;

  beforeEach(async () => {
    conversionEscrowProgram = await initConversionEscrow(
      provider,
      anchor.workspace.ConversionEscrow.programId,
      anchor.workspace.ConversionEscrow.idl
    );
    dcProgram = await initDataCredits(
      provider,
      anchor.workspace.DataCredits.programId,
      anchor.workspace.DataCredits.idl
    );

    await ensureDCIdl(dcProgram);

    noEmitProgram = await initBurn(
      provider,
      anchor.workspace.NoEmit.programId,
      anchor.workspace.NoEmit.idl,
    )

    hsdProgram = await initHeliumSubDaos(
      provider,
      anchor.workspace.HeliumSubDaos.programId,
      anchor.workspace.HeliumSubDaos.idl
    );

    await ensureHSDIdl(hsdProgram);

    hemProgram = await initHeliumEntityManager(
      provider,
      anchor.workspace.HeliumEntityManager.programId,
      anchor.workspace.HeliumEntityManager.idl
    );
    await ensureHEMIdl(hemProgram);

    const dataCredits = await initTestDataCredits(
      dcProgram,
      provider,
      100000000000
    );
    dcMint = dataCredits.dcMint;
    ({ dao, mint: hntMint } = await initTestDao(
      hsdProgram,
      provider,
      100,
      me,
      dataCredits.dcMint,
      dataCredits.hntMint,
    ));
    activeDeviceAuthority = Keypair.generate();
    ({ subDao, mint: dntMint } = await initTestSubdao({
      hsdProgram,
      provider,
      authority: me,
      dao,
      activeDeviceAuthority: activeDeviceAuthority.publicKey,
      // Add some padding for onboards
      numTokens: MAKER_STAKING_FEE.mul(new BN(2)).add(new BN(10000000000)),
    }));
  });

  it("issues iot operations fund", async () => {
    const mint = Keypair.generate();
    await hemProgram.methods
      .issueIotOperationsFundV0()
      .preInstructions(await createMintInstructions(provider, 0, me, me, mint))
      .accounts({
        dao,
        recipient: me,
        mint: mint.publicKey,
      })
      .signers([mint])
      .rpc({ skipPreflight: true });

    const addr = getAssociatedTokenAddressSync(mint.publicKey, me);
    const balance = await provider.connection.getTokenAccountBalance(addr);
    expect(balance.value.uiAmount).to.eq(1);
  });

  it("issues burn entity, and allows burn", async () => {
    const mint = Keypair.generate();
    await hemProgram.methods
      .issueNotEmittedEntityV0()
      .preInstructions(await createMintInstructions(provider, 0, me, me, mint))
      .accounts({
        dao,
        mint: mint.publicKey,
      })
      .signers([mint])
      .rpc({ skipPreflight: true });

    const addr = getAssociatedTokenAddressSync(mint.publicKey, notEmittedKey()[0], true);
    const balance = await provider.connection.getTokenAccountBalance(addr);
    expect(balance.value.uiAmount).to.eq(1);

    const tokenMint = await createMint(provider, 2, me, me)
    const burnAta = await createAtaAndMint(provider, tokenMint, new BN(1000), notEmittedKey()[0])
    await noEmitProgram.methods.noEmitV0()
    .accounts({
      mint: tokenMint
    })
    .rpc({ skipPreflight: true })

    const postBalance = (await getAccount(provider.connection, burnAta)).amount;
    expect(postBalance).to.eq(BigInt(0));
  });

  it("initializes a rewardable entity config", async () => {
    const { rewardableEntityConfig } = await initTestRewardableEntityConfig(
      hemProgram,
      subDao
    );

    const account = await hemProgram.account.rewardableEntityConfigV0.fetch(
      rewardableEntityConfig
    );

    expect(account.authority.toBase58()).eq(
      provider.wallet.publicKey.toBase58()
    );
  });

  it("initializes a data only config", async () => {
    const [height, buffer, canopy] = [14, 64, 11];
    const merkle = Keypair.generate();
    const space = getConcurrentMerkleTreeAccountSize(height, buffer, canopy);
    const cost = await provider.connection.getMinimumBalanceForRentExemption(
      space
    );
    await sendInstructions(
      provider,
      [
        SystemProgram.createAccount({
          fromPubkey: provider.wallet.publicKey,
          newAccountPubkey: merkle.publicKey,
          lamports: cost,
          space: space,
          programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
        }),
      ],
      [merkle]
    );
    await hemProgram.methods
      .initializeDataOnlyV0({
        authority: me,
        newTreeDepth: height,
        newTreeBufferSize: buffer,
        newTreeSpace: new BN(
          getConcurrentMerkleTreeAccountSize(height, buffer, canopy)
        ),
        newTreeFeeLamports: new BN((LAMPORTS_PER_SOL * 30) / 2 ** height),
        name: "DATAONLY",
        metadataUrl: "test",
      })
      .accounts({
        dao,
        merkleTree: merkle.publicKey,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
      ])
      .rpc();
  });

  describe("with data only config", () => {
    let ecc: string;
    let rewardableEntityConfig: PublicKey;
    let getAssetFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<Asset | undefined>;
    let getAssetProofFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<AssetProof | undefined>;
    let hotspotOwner = Keypair.generate();
    let hotspot: PublicKey;
    let startDcBal = DC_FEE * 10;

    beforeEach(async () => {
      ({ rewardableEntityConfig } = await initTestRewardableEntityConfig(
        hemProgram,
        subDao
      ));
      ecc = (await HeliumKeypair.makeRandom()).address.b58;
      const [height, buffer, canopy] = [3, 8, 0];
      const merkle = Keypair.generate();
      const space = getConcurrentMerkleTreeAccountSize(height, buffer, canopy);
      const cost = await provider.connection.getMinimumBalanceForRentExemption(
        space
      );
      await sendInstructions(
        provider,
        [
          SystemProgram.createAccount({
            fromPubkey: provider.wallet.publicKey,
            newAccountPubkey: merkle.publicKey,
            lamports: cost,
            space: space,
            programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
          }),
        ],
        [merkle]
      );
      await hemProgram.methods
        .initializeDataOnlyV0({
          authority: me,
          newTreeDepth: height,
          newTreeBufferSize: buffer,
          newTreeSpace: new BN(
            getConcurrentMerkleTreeAccountSize(height, buffer, canopy)
          ),
          newTreeFeeLamports: new BN((LAMPORTS_PER_SOL * 30) / 2 ** height),
          name: "DATAONLY",
          metadataUrl: "test",
        })
        .accounts({
          dao,
          merkleTree: merkle.publicKey,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
        ])
        .rpc({ skipPreflight: true });

      const doAcc = await hemProgram.account.dataOnlyConfigV0.fetch(
        dataOnlyConfigKey(dao)[0]
      );

      ({ getAssetFn, getAssetProofFn, hotspot } = await createMockCompression({
        collection: doAcc.collection,
        dao,
        merkle: merkle.publicKey,
        ecc,
        hotspotOwner,
      }));

      await dcProgram.methods
        .mintDataCreditsV0({
          hntAmount: toBN(startDcBal, 8),
          dcAmount: null,
        })
        .accounts({ dcMint })
        .rpc({ skipPreflight: true });
    });
    it("issues and onboards a data only hotspot", async () => {
      let hotspotOwner = Keypair.generate();
      const issueMethod = hemProgram.methods
        .issueDataOnlyEntityV0({
          entityKey: Buffer.from(bs58.decode(ecc)),
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
        ])
        .accounts({
          recipient: hotspotOwner.publicKey,
          dao,
          eccVerifier: eccVerifier.publicKey,
        })
        .signers([eccVerifier]);

      const { keyToAsset } = await issueMethod.pubkeys();
      await issueMethod.rpc({ skipPreflight: true });

      console.log(keyToAsset?.toString());
      const ktaAcc = await hemProgram.account.keyToAssetV0.fetch(keyToAsset!);
      expect(Boolean(ktaAcc)).to.be.true;
      expect(ktaAcc.asset.toString()).to.eq(hotspot.toString());
      expect(ktaAcc.dao.toString()).to.eq(dao.toString());

      const { args } = await proofArgsAndAccounts({
        connection: hemProgram.provider.connection,
        assetId: hotspot,
        getAssetFn,
        getAssetProofFn,
      });
      const onboardMethod = hemProgram.methods
        .onboardDataOnlyIotHotspotV0({
          ...args,
          location: null,
          elevation: 50,
          gain: 100,
        })
        .accounts({
          rewardableEntityConfig,
          hotspotOwner: hotspotOwner.publicKey,
          keyToAsset,
          iotInfo: iotInfoKey(rewardableEntityConfig, ecc)[0],
          subDao,
        })
        .signers([hotspotOwner]);

      const { iotInfo } = await onboardMethod.pubkeys();
      await onboardMethod.rpc();

      const iotInfoAccount = await hemProgram.account.iotHotspotInfoV0.fetch(
        iotInfo!
      );
      expect(Boolean(iotInfoAccount)).to.be.true;
      expect(iotInfoAccount.asset.toString()).to.eq(hotspot.toString());
      expect(iotInfoAccount.location).to.be.null;
      expect(iotInfoAccount.elevation).to.eq(50);
      expect(iotInfoAccount.gain).to.eq(100);
      expect(iotInfoAccount.isFullHotspot).to.be.false;

      const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
      expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(
        subDaoAcc.onboardingDataOnlyDcFee.toNumber()
      );
    });

    it("can swap tree when it's full", async () => {
      let hotspotOwner = Keypair.generate();

      // fill up the tree
      while (true) {
        try {
          ecc = (await HeliumKeypair.makeRandom()).address.b58;
          await hemProgram.methods
            .issueDataOnlyEntityV0({
              entityKey: Buffer.from(bs58.decode(ecc)),
            })
            .preInstructions([
              ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
            ])
            .accounts({
              recipient: hotspotOwner.publicKey,
              dao,
              eccVerifier: eccVerifier.publicKey,
            })
            .signers([eccVerifier])
            .rpc({ skipPreflight: true });
        } catch (err) {
          break;
        }
      }
      const [height, buffer, canopy] = [3, 8, 0];
      const newMerkle = Keypair.generate();
      const space = getConcurrentMerkleTreeAccountSize(height, buffer, canopy);
      const cost = await provider.connection.getMinimumBalanceForRentExemption(
        space
      );
      await sendInstructions(
        provider,
        [
          SystemProgram.createAccount({
            fromPubkey: provider.wallet.publicKey,
            newAccountPubkey: newMerkle.publicKey,
            lamports: cost,
            space: space,
            programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
          }),
        ],
        [newMerkle]
      );
      await hemProgram.methods
        .updateDataOnlyTreeV0()
        .accounts({
          dataOnlyConfig: dataOnlyConfigKey(dao)[0],
          newMerkleTree: newMerkle.publicKey,
        })
        .rpc({ skipPreflight: true });
    });
  });

  it("initializes a maker", async () => {
    const { rewardableEntityConfig } = await initTestRewardableEntityConfig(
      hemProgram,
      subDao
    );

    const { maker, collection, makerKeypair } = await initTestMaker(
      hemProgram,
      provider,
      rewardableEntityConfig,
      dao
    );

    const account = await hemProgram.account.makerV0.fetch(maker);

    expect(account.collection.toBase58()).eq(collection.toBase58());
    expect(account.issuingAuthority.toBase58()).eq(
      makerKeypair.publicKey.toBase58()
    );
    expect(account.updateAuthority.toBase58()).eq(
      makerKeypair.publicKey.toBase58()
    );
  });

  it("allows revoking a maker", async () => {
    const { rewardableEntityConfig } = await initTestRewardableEntityConfig(
      hemProgram,
      subDao
    );

    const { maker } = await initTestMaker(
      hemProgram,
      provider,
      rewardableEntityConfig,
      dao
    );

    const {
      pubkeys: { makerApproval },
    } = await hemProgram.methods
      .revokeMakerV0()
      .accounts({
        maker,
        rewardableEntityConfig,
      })
      .rpcAndKeys();

    const account = await hemProgram.account.makerApprovalV0.fetchNullable(
      makerApproval!
    );
    expect(account).to.be.null;
  });

  it("allows approving and revoking programs", async () => {
    const keypair = Keypair.generate();
    const {
      pubkeys: { programApproval },
    } = await hemProgram.methods
      .approveProgramV0({
        programId: keypair.publicKey,
      })
      .accounts({
        dao,
      })
      .rpcAndKeys();

    const account = await hemProgram.account.programApprovalV0.fetch(
      programApproval!
    );
    expect(account.programId.toBase58()).eq(keypair.publicKey.toBase58());
    await hemProgram.methods
      .revokeProgramV0({
        programId: keypair.publicKey,
      })
      .accounts({
        dao,
      })
      .rpc();

    const account2 = await hemProgram.account.programApprovalV0.fetchNullable(
      programApproval!
    );
    expect(account2).to.be.null;
  });

  describe("with mobile maker and data credits", () => {
    let makerKeypair: Keypair;
    let maker: PublicKey;
    let startDcBal = DC_FEE * 10;

    let getAssetFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<Asset | undefined>;
    let getAssetProofFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<AssetProof | undefined>;
    let rewardableEntityConfig: PublicKey;
    let ecc: string;
    let hotspot: PublicKey;
    let hotspotOwner = Keypair.generate();
    beforeEach(async () => {
      ecc = (await HeliumKeypair.makeRandom()).address.b58;

      ({ rewardableEntityConfig } = await initTestRewardableEntityConfig(
        hemProgram,
        subDao,
        {
          mobileConfigV2: {
            feesByDevice: [
              {
                deviceType: { cbrs: {} },
                dcOnboardingFee: toBN(0, 5),
                locationStakingFee: toBN(10, 5),
                mobileOnboardingFeeUsd: toBN(0, 6),
                reserved: new Array(8).fill(new BN(0)),
              },
              {
                deviceType: { wifiIndoor: {} },
                dcOnboardingFee: toBN(10, 5),
                locationStakingFee: toBN(0, 5),
                mobileOnboardingFeeUsd: toBN(10, 6),
                reserved: new Array(8).fill(new BN(0)),
              },
              {
                deviceType: { wifiOutdoor: {} },
                dcOnboardingFee: toBN(10, 5),
                locationStakingFee: toBN(0, 5),
                mobileOnboardingFeeUsd: toBN(20, 6),
                reserved: new Array(8).fill(new BN(0)),
              },
            ],
          },
        }
      ));

      const makerConf = await initTestMaker(
        hemProgram,
        provider,
        rewardableEntityConfig,
        dao
      );

      await initTestMaker(hemProgram, provider, rewardableEntityConfig, dao);

      await dcProgram.methods
        .mintDataCreditsV0({
          hntAmount: toBN(startDcBal, 8),
          dcAmount: null,
        })
        .accounts({ dcMint })
        .rpc({ skipPreflight: true });

      maker = makerConf.maker;
      makerKeypair = makerConf.makerKeypair;

      ({ getAssetFn, getAssetProofFn, hotspot } = await createMockCompression({
        collection: makerConf.collection,
        dao,
        merkle: makerConf.merkle,
        ecc,
        hotspotOwner,
      }));
    });

    // Only uncomment this when you want to debug the sig verifier service locally.
    // You can run it like:
    // env ANCHOR_WALLET=path/to//helium-program-library/tests/verifier-test.json cargo run
    xit("properly uses the sig verifier service", async () => {
      const issueTx =
        "CroBCiEB7UTmtDnUwT3fGbvn4ASvsi5n6wJiNTs/euxRYXFWiRASIQCIruPASTMtSA87u0hkkApMXY/q2cydP5We1vkyUj9fiSJGMEQCIA46K0Xug+nxpaLi9z25jEI5RtHmWTtvgZFOQBr06jzKAiBifpM+/m/k3SwDAES9FA9QqPv4ElDhh+zCqMbJ15DqYiohAfK7mMA4Bu0mM6e/N81WeNbTEFdgyo4A5g5MgsPQjMazOICS9AFA6PsD";
      const txn = AddGatewayV1.fromString(issueTx);
      const eccKey = txn.gateway?.b58;
      // @ts-ignore
      const addGateway = txn.toProto(true);
      const serialized = helium.blockchain_txn_add_gateway_v1
        .encode(addGateway)
        .finish();

      let tx = await hemProgram.methods
        .issueEntityV0({
          entityKey: Buffer.from(bs58.decode(eccKey!)),
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
        ])
        .accounts({
          maker,
          recipient: hotspotOwner.publicKey,
          issuingAuthority: makerKeypair.publicKey,
          dao,
          eccVerifier: eccVerifier.publicKey,
        })
        .signers([makerKeypair])
        .transaction();
      tx.recentBlockhash = (
        await provider.connection.getRecentBlockhash()
      ).blockhash;
      tx.feePayer = provider.wallet.publicKey;
      tx.partialSign(makerKeypair);
      tx = await provider.wallet.signTransaction(tx);

      const { transaction } = (
        await axios.post("http://localhost:8000/verify", {
          transaction: tx
            .serialize({
              requireAllSignatures: false,
            })
            .toString("hex"),
          msg: Buffer.from(serialized).toString("hex"),
          signature: Buffer.from(txn.gatewaySignature!).toString("hex"),
        })
      ).data;
      const sig = await provider.connection.sendRawTransaction(
        Buffer.from(transaction, "hex")
      );
      await provider.connection.confirmTransaction(sig);
    });

    describe("with voucher", async () => {
      let mobileHotspotVoucher: PublicKey | undefined;
      let conversionEscrow: PublicKey | undefined;
      let usdcMint: PublicKey;
      const slippageBps = 5;

      beforeEach(async () => {
        await ensureConversionEscrowIdl(conversionEscrowProgram);
        usdcMint = await createMint(provider, 6, me, me);

        ({
          pubkeys: { conversionEscrow },
        } = await hemProgram.methods
          .initializeMakerEscrowV0({
            oracle: USDC_PYTH_PRICE_FEED,
            // Slippage can be super low since price isn't changing.
            targets: [
              {
                mint: dntMint,
                slippageBps,
                oracle: MOBILE_PYTH_PRICE_FEED,
              },
              {
                mint: hntMint,
                slippageBps,
                oracle: HNT_PYTH_PRICE_FEED,
              },
              {
                mint: NATIVE_MINT,
                slippageBps,
                oracle: SOL_PYTH_PRICE_FEED,
              }
            ],
          })
          .accounts({
            maker,
            payer: me,
            mint: usdcMint,
            updateAuthority: makerKeypair.publicKey,
          })
          .signers([makerKeypair])
          .rpcAndKeys({ skipPreflight: true }));

        // Populate the escrow
        await createAtaAndMint(
          provider,
          usdcMint,
          toBN(1000000, 6).toNumber(),
          conversionEscrow
        );

        ({
          pubkeys: { mobileHotspotVoucher },
        } = await hemProgram.methods
          .initializeMobileHotspotVoucherV0({
            entityKey: Buffer.from(bs58.decode(ecc)),
            keySerialization: { b58: {} },
            deviceType: { wifiOutdoor: {} },
          })
          .accounts({
            maker,
            rewardableEntityConfig,
            issuingAuthority: makerKeypair.publicKey,
          })
          .signers([makerKeypair])
          .rpcAndKeys({ skipPreflight: true }));
        
      });

      it("allows verifying owner while topping off sol", async () => {
        const owner = Keypair.generate()
        const makerWsol = getAssociatedTokenAddressSync(
          NATIVE_MINT,
          maker,
          true
        );
        const myUsdcAccount = getAssociatedTokenAddressSync(usdcMint, me);
        const instructions = [
          createAssociatedTokenAccountIdempotentInstruction(
            me,
            myUsdcAccount,
            me,
            usdcMint
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            me,
            makerWsol,
            maker,
            NATIVE_MINT
          ),
          await hemProgram.methods
            .makerLendV0({
              amount: toBN(0.02, 9),
            })
            .accounts({
              maker,
              targetOracle: SOL_PYTH_PRICE_FEED,
              conversionEscrow,
              destination: myUsdcAccount,
              repayAccount: makerWsol,
              usdcMint,
            })
            .instruction(),
          // Repay
          SystemProgram.transfer({
            fromPubkey: me,
            toPubkey: makerWsol,
            lamports: 0.02 * LAMPORTS_PER_SOL,
          }),
          await conversionEscrowProgram.methods
            .checkRepayV0()
            .accounts({
              conversionEscrow,
              repayAccount: makerWsol,
            })
            .instruction(),
          await hemProgram.methods
            .mobileVoucherVerifyOwnerV0()
            .accounts({
              verifiedOwner: owner.publicKey,
              eccVerifier: eccVerifier.publicKey,
              mobileHotspotVoucher,
            })
            .instruction(),
        ];
        await sendInstructions(provider, instructions, [eccVerifier]);
        const voucher = await hemProgram.account.mobileHotspotVoucherV0.fetch(
          mobileHotspotVoucher!
        );
        expect(voucher.verifiedOwner.toBase58()).to.eq(owner.publicKey.toBase58());
        const lamps = (await provider.connection.getAccountInfo(owner.publicKey))?.lamports
        expect(lamps).to.be.gt(0.02 * LAMPORTS_PER_SOL)
      });
      describe("with verified owner", async () => {
        beforeEach(async () => {
          await hemProgram.methods
            .mobileVoucherVerifyOwnerV0()
            .accounts({
              verifiedOwner: me,
              eccVerifier: eccVerifier.publicKey,
              mobileHotspotVoucher,
            })
            .signers([eccVerifier])
            .rpc({ skipPreflight: true });
        })
        it("allows paying mobile", async () => {
          const makerDntAccount = getAssociatedTokenAddressSync(
            dntMint,
            maker,
            true
          );
          const pythDataMobile = (await provider.connection.getAccountInfo(
            MOBILE_PYTH_PRICE_FEED
          ))!.data;
          const priceMobile = parsePriceData(pythDataMobile);

          const usdPerMobile =
            priceMobile.emaPrice.value - priceMobile.emaConfidence!.value * 2;
          const mobileAmount = toBN(20 / usdPerMobile, 6);
          const myUsdcAccount = getAssociatedTokenAddressSync(usdcMint, me);
          const instructions = [
            createAssociatedTokenAccountIdempotentInstruction(
              me,
              myUsdcAccount,
              me,
              usdcMint
            ),
            await hemProgram.methods
              .makerLendV0({
                amount: toBN(20, 6),
              })
              .accounts({
                maker,
                targetOracle: MOBILE_PYTH_PRICE_FEED,
                conversionEscrow,
                destination: myUsdcAccount,
                repayAccount: makerDntAccount,
                usdcMint,
              })
              .instruction(),
            // Repay
            createAssociatedTokenAccountIdempotentInstruction(
              me,
              makerDntAccount,
              maker,
              dntMint
            ),
            createTransferInstruction(
              getAssociatedTokenAddressSync(dntMint, me),
              makerDntAccount,
              me,
              BigInt(mobileAmount.toString())
            ),
            await conversionEscrowProgram.methods
              .checkRepayV0()
              .accounts({
                conversionEscrow,
                repayAccount: makerDntAccount,
              })
              .instruction(),
            await hemProgram.methods
              .mobileVoucherPayMobileV0()
              .accounts({
                mobileHotspotVoucher,
                dntPrice: MOBILE_PYTH_PRICE_FEED,
              })
              .instruction(),
          ];
          await sendInstructions(provider, instructions);
          const voucher = await hemProgram.account.mobileHotspotVoucherV0.fetch(
            mobileHotspotVoucher!
          );
          expect(voucher.paidMobile).to.be.true;
        });

        it("allows paying DC", async () => {
          const makerHntAccount = getAssociatedTokenAddressSync(
            hntMint,
            maker,
            true
          );
          const myUsdcAccount = getAssociatedTokenAddressSync(usdcMint, me);
          const instructions = [
            createAssociatedTokenAccountIdempotentInstruction(
              me,
              myUsdcAccount,
              me,
              usdcMint
            ),
            createAssociatedTokenAccountIdempotentInstruction(
              me,
              makerHntAccount,
              maker,
              hntMint
            ),
            await hemProgram.methods
              .makerLendV0({
                amount: toBN(10, 6),
              })
              .accounts({
                maker,
                targetOracle: HNT_PYTH_PRICE_FEED,
                conversionEscrow,
                destination: myUsdcAccount,
                repayAccount: makerHntAccount,
                usdcMint,
              })
              .instruction(),
            // Repay in HNT
            createTransferInstruction(
              getAssociatedTokenAddressSync(hntMint, me),
              makerHntAccount,
              me,
              BigInt(10000000000)
            ),
            await conversionEscrowProgram.methods
              .checkRepayV0()
              .accounts({
                conversionEscrow,
                repayAccount: makerHntAccount,
              })
              .instruction(),
            await hemProgram.methods
              .mobileVoucherPayDcV0()
              .accounts({
                mobileHotspotVoucher,
              })
              .instruction(),
          ];
          await sendInstructions(provider, instructions);
          const voucher = await hemProgram.account.mobileHotspotVoucherV0.fetch(
            mobileHotspotVoucher!
          );
          expect(voucher.paidDc).to.be.true;
        });

        it("fits a jupiter transaction in with flash lend mobile", async () => {
          const { instructions, addressLookupTableAddresses } =
            await payMobileVoucherMobile({
              program: hemProgram,
              ceProgram: conversionEscrowProgram,
              mobileHotspotVoucher: mobileHotspotVoucher!,
              verifiedOwner: me,
              maker,
              payer: me,
            });
          const tx = await toVersionedTx({
            instructions: [
              await hemProgram.methods
                .mobileVoucherVerifyOwnerV0()
                .accounts({
                  verifiedOwner: me,
                  eccVerifier: eccVerifier.publicKey,
                  mobileHotspotVoucher,
                })
                .instruction(),
              ...instructions,
            ],
            addressLookupTableAddresses: [
              ...addressLookupTableAddresses,
              HELIUM_COMMON_LUT,
            ],
            connection: new Connection("https://api.mainnet-beta.solana.com"),
            payer: me,
          });
          await tx.sign([eccVerifier]);
          const signed = await provider.wallet.signTransaction(tx);
          const serialized = signed.serialize();
          expect(serialized.length).to.be.lessThan(1232);
        });

        it("fits a jupiter transaction in with flash lend dc", async () => {
          const { instructions, addressLookupTableAddresses } =
            await payMobileVoucherDc({
              program: hemProgram,
              ceProgram: conversionEscrowProgram,
              mobileHotspotVoucher: mobileHotspotVoucher!,
              verifiedOwner: me,
              maker,
              payer: me,
            });
          const tx = await toVersionedTx({
            instructions,
            addressLookupTableAddresses: [
              ...addressLookupTableAddresses,
              HELIUM_COMMON_LUT,
            ],
            connection: new Connection("https://api.mainnet-beta.solana.com"),
            payer: me,
          });
          const signed = await provider.wallet.signTransaction(tx);
          const serialized = signed.serialize();
          expect(serialized.length).to.be.lessThan(1232);
        });

        describe("when fully paid", () => {
          beforeEach(async () => {
            const makerDntAccount = getAssociatedTokenAddressSync(
              dntMint,
              maker,
              true
            );
            const pythDataMobile = (await provider.connection.getAccountInfo(
              MOBILE_PYTH_PRICE_FEED
            ))!.data;
            const priceMobile = parsePriceData(pythDataMobile);

            const usdPerMobile =
              priceMobile.emaPrice.value - priceMobile.emaConfidence!.value * 2;
            const mobileAmount = toBN(20 / usdPerMobile, 6);
            const myUsdcAccount = getAssociatedTokenAddressSync(usdcMint, me);
            const instructions0 = [
              createAssociatedTokenAccountIdempotentInstruction(
                me,
                myUsdcAccount,
                me,
                usdcMint
              ),
              await hemProgram.methods
                .makerLendV0({
                  amount: toBN(20, 6),
                })
                .accounts({
                  maker,
                  targetOracle: MOBILE_PYTH_PRICE_FEED,
                  conversionEscrow,
                  destination: myUsdcAccount,
                  repayAccount: makerDntAccount,
                  usdcMint,
                })
                .instruction(),
              // Repay
              createAssociatedTokenAccountIdempotentInstruction(
                me,
                makerDntAccount,
                maker,
                dntMint
              ),
              createTransferInstruction(
                getAssociatedTokenAddressSync(dntMint, me),
                makerDntAccount,
                me,
                BigInt(mobileAmount.toString())
              ),
              await conversionEscrowProgram.methods
                .checkRepayV0()
                .accounts({
                  conversionEscrow,
                  repayAccount: makerDntAccount,
                })
                .instruction(),
              await hemProgram.methods
                .mobileVoucherPayMobileV0()
                .accounts({
                  mobileHotspotVoucher,
                  dntPrice: MOBILE_PYTH_PRICE_FEED,
                })
                .instruction(),
            ];
            await sendInstructions(provider, instructions0);
            const makerHntAccount = getAssociatedTokenAddressSync(
              hntMint,
              maker,
              true
            );
            const instructions = [
              createAssociatedTokenAccountIdempotentInstruction(
                me,
                myUsdcAccount,
                me,
                usdcMint
              ),
              createAssociatedTokenAccountIdempotentInstruction(
                me,
                makerHntAccount,
                maker,
                hntMint
              ),
              await hemProgram.methods
                .makerLendV0({
                  amount: toBN(10, 6),
                })
                .accounts({
                  maker,
                  targetOracle: HNT_PYTH_PRICE_FEED,
                  conversionEscrow,
                  destination: myUsdcAccount,
                  repayAccount: makerHntAccount,
                  usdcMint,
                })
                .instruction(),
              // Repay in HNT
              createTransferInstruction(
                getAssociatedTokenAddressSync(hntMint, me),
                makerHntAccount,
                me,
                BigInt(10000000000)
              ),
              await conversionEscrowProgram.methods
                .checkRepayV0()
                .accounts({
                  conversionEscrow,
                  repayAccount: makerHntAccount,
                })
                .instruction(),
              await hemProgram.methods
                .mobileVoucherPayDcV0()
                .accounts({
                  mobileHotspotVoucher,
                })
                .instruction(),
            ];
            await sendInstructions(provider, instructions);
          });

          it("issues a mobile hotspot", async () => {
            const method = await hemProgram.methods
              .issueMobileHotspotV0({
                entityKey: Buffer.from(bs58.decode(ecc)),
              })
              .accounts({
                issueEntityCommon: {
                  maker,
                  recipient: me,
                  dao,
                },
                mobileInfo: mobileInfoKey(
                  rewardableEntityConfig,
                  Buffer.from(bs58.decode(ecc))
                )[0],
                voucher: mobileHotspotVoucher,
              });
            await method.rpc({ skipPreflight: true });
            const { mobileInfo } = await method.pubkeys();

            const mobileInfoAcc =
              await hemProgram.account.mobileHotspotInfoV0.fetch(mobileInfo!);
            expect(Boolean(mobileInfoAcc)).to.be.true;
            const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
            expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(1000000);
          });
        });
      })
    })

    it("issues a mobile hotspot", async () => {
      await hemProgram.methods
        .issueEntityV0({
          entityKey: Buffer.from(bs58.decode(ecc)),
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }),
        ])
        .accounts({
          maker,
          recipient: hotspotOwner.publicKey,
          issuingAuthority: makerKeypair.publicKey,
          dao,
          eccVerifier: eccVerifier.publicKey,
        })
        .signers([makerKeypair, eccVerifier])
        .rpc({ skipPreflight: true });

      const method = (
        await onboardMobileHotspot({
          program: hemProgram,
          assetId: hotspot,
          maker,
          dao,
          rewardableEntityConfig,
          getAssetFn,
          getAssetProofFn,
          deviceType: "wifiIndoor",
        })
      ).signers([makerKeypair, hotspotOwner]);

      await method.rpc({ skipPreflight: true });
      const { mobileInfo } = await method.pubkeys();

      const mobileInfoAcc = await hemProgram.account.mobileHotspotInfoV0.fetch(
        mobileInfo!
      );
      expect(Boolean(mobileInfoAcc)).to.be.true;
      const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
      expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(1000000);
    });

    describe("with hotspot", () => {
      let infoKey: PublicKey | undefined;
      beforeEach(async () => {
        await hemProgram.methods
          .issueEntityV0({
            entityKey: Buffer.from(bs58.decode(ecc)),
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
          ])
          .accounts({
            maker,
            dao,
            recipient: hotspotOwner.publicKey,
            issuingAuthority: makerKeypair.publicKey,
            eccVerifier: eccVerifier.publicKey,
          })
          .signers([makerKeypair, eccVerifier])
          .rpc({ skipPreflight: true });

        await hsdProgram.methods
          .updateSubDaoV0({
            authority: null,
            dcBurnAuthority: null,
            emissionSchedule: null,
            onboardingDcFee: new BN(0),
            onboardingDataOnlyDcFee: null,
            registrar: null,
            delegatorRewardsPercent: null,
            activeDeviceAuthority: null,
          })
          .accounts({
            subDao,
          })
          .rpc({ skipPreflight: true });

        const method = (
          await onboardMobileHotspot({
            program: hemProgram,
            assetId: hotspot,
            maker,
            dao,
            rewardableEntityConfig,
            getAssetFn,
            getAssetProofFn,
            location: new BN(100),
          })
        ).signers([makerKeypair, hotspotOwner]);

        ({ mobileInfo: infoKey } = await method.pubkeys());

        await method.rpc({ skipPreflight: true });

        await dcProgram.methods
          .mintDataCreditsV0({
            hntAmount: toBN(startDcBal, 8),
            dcAmount: null,
          })
          .accounts({ dcMint, recipient: hotspotOwner.publicKey })
          .rpc();
      });

      it("onboarding fees be backpaid with DC when subdao fees are raised", async () => {
        const method = hemProgram.methods
          .tempPayMobileOnboardingFeeV0()
          .accounts({
            rewardableEntityConfig,
            subDao,
            dao,
            keyToAsset: keyToAssetKey(dao, ecc)[0],
            mobileInfo: infoKey!,
          });
        const ata = getAssociatedTokenAddressSync(
          dcMint,
          provider.wallet.publicKey
        );
        const preBalance = await provider.connection.getTokenAccountBalance(
          ata
        );
        const preInfoAcc = await hemProgram.account.mobileHotspotInfoV0.fetch(
          infoKey!
        );
        expect(preInfoAcc.dcOnboardingFeePaid.toNumber()).to.eq(0);

        await hemProgram.methods
          .updateRewardableEntityConfigV0({
            settings: {
              mobileConfigV2: {
                feesByDevice: [
                  {
                    deviceType: { cbrs: {} },
                    dcOnboardingFee: toBN(40, 5),
                    locationStakingFee: toBN(10, 5),
                    mobileOnboardingFeeUsd: toBN(0, 6),
                    reserved: new Array(8).fill(new BN(0)),
                  },
                  {
                    deviceType: { wifiIndoor: {} },
                    dcOnboardingFee: toBN(10, 5),
                    locationStakingFee: toBN(0, 5),
                    mobileOnboardingFeeUsd: toBN(10, 6),
                    reserved: new Array(8).fill(new BN(0)),
                  },
                  {
                    deviceType: { wifiOutdoor: {} },
                    dcOnboardingFee: toBN(10, 5),
                    locationStakingFee: toBN(0, 5),
                    mobileOnboardingFeeUsd: toBN(20, 6),
                    reserved: new Array(8).fill(new BN(0)),
                  },
                ],
              },
            },
            newAuthority: null,
            stakingRequirement: MAKER_STAKING_FEE,
          })
          .accounts({ rewardableEntityConfig })
          .rpc({ skipPreflight: true });

        await method.rpc({ skipPreflight: true });

        const postBalance = await provider.connection.getTokenAccountBalance(
          ata
        );
        expect(postBalance.value.uiAmount).to.be.eq(
          preBalance.value.uiAmount! - toBN(40, 5).toNumber()
        );
        const infoAcc = await hemProgram.account.mobileHotspotInfoV0.fetch(
          infoKey!
        );
        expect(infoAcc.dcOnboardingFeePaid.toNumber()).to.eq(
          toBN(40, 5).toNumber()
        );
      });

      it("changes the metadata", async () => {
        const location = new BN(1000);

        const method = (
          await updateMobileMetadata({
            program: hemProgram,
            assetId: hotspot,
            rewardableEntityConfig,
            location,
            getAssetFn,
            getAssetProofFn,
          })
        ).signers([hotspotOwner]);

        const info = (await method.pubkeys()).mobileInfo!;
        await method.rpc({ skipPreflight: true });

        const storageAcc = await hemProgram.account.mobileHotspotInfoV0.fetch(
          info!
        );
        expect(storageAcc.location?.toNumber()).to.eq(location.toNumber());
      });

      it("oracle can update active status", async () => {
        await hemProgram.methods
          .setEntityActiveV0({
            isActive: false,
            entityKey: Buffer.from(bs58.decode(ecc)),
          })
          .accounts({
            activeDeviceAuthority: activeDeviceAuthority.publicKey,
            rewardableEntityConfig,
            info: infoKey!,
          })
          .signers([activeDeviceAuthority])
          .rpc({ skipPreflight: true });

        const infoAcc = await hemProgram.account.mobileHotspotInfoV0.fetch(
          infoKey!
        );
        expect(infoAcc.isActive).to.be.false;
        const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
        expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(0);
      });
    });
  });

  describe("with iot maker and data credits", () => {
    let makerKeypair: Keypair;
    let maker: PublicKey;
    let startDcBal = DC_FEE * 10;

    let merkleTree: MerkleTree;
    let getAssetFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<Asset | undefined>;
    let getAssetProofFn: (
      url: string,
      assetId: PublicKey
    ) => Promise<AssetProof | undefined>;
    let hotspotCollection: PublicKey;
    let rewardableEntityConfig: PublicKey;
    let ecc: string;
    let hotspot: PublicKey;
    let hotspotOwner = Keypair.generate();
    let metadata: any;

    beforeEach(async () => {
      ecc = (await HeliumKeypair.makeRandom()).address.b58;

      ({ rewardableEntityConfig } = await initTestRewardableEntityConfig(
        hemProgram,
        subDao
      ));
      const makerConf = await initTestMaker(
        hemProgram,
        provider,
        rewardableEntityConfig,
        dao
      );

      await initTestMaker(hemProgram, provider, rewardableEntityConfig, dao);

      await dcProgram.methods
        .mintDataCreditsV0({
          hntAmount: toBN(startDcBal, 8),
          dcAmount: null,
        })
        .accounts({ dcMint: dcMint })
        .rpc({ skipPreflight: true });

      maker = makerConf.maker;
      makerKeypair = makerConf.makerKeypair;
      hotspotCollection = makerConf.collection;

      ({ getAssetFn, getAssetProofFn, hotspot } = await createMockCompression({
        collection: makerConf.collection,
        dao,
        merkle: makerConf.merkle,
        ecc,
        hotspotOwner,
      }));
    });

    it("issues an iot hotspot", async () => {
      await hemProgram.methods
        .issueEntityV0({
          entityKey: Buffer.from(bs58.decode(ecc)),
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
        ])
        .accounts({
          maker,
          dao,
          recipient: hotspotOwner.publicKey,
          issuingAuthority: makerKeypair.publicKey,
          eccVerifier: eccVerifier.publicKey,
        })
        .signers([makerKeypair, eccVerifier])
        .rpc({ skipPreflight: true });

      const method = (
        await onboardIotHotspot({
          program: hemProgram,
          assetId: hotspot,
          maker,
          dao,
          rewardableEntityConfig,
          location: new BN(1000),
          getAssetFn,
          getAssetProofFn,
        })
      ).signers([makerKeypair, hotspotOwner]);

      await method.rpc({ skipPreflight: true });
      const { iotInfo } = await method.pubkeys();

      const iotInfoAccount = await hemProgram.account.iotHotspotInfoV0.fetch(
        iotInfo!
      );
      expect(Boolean(iotInfoAccount)).to.be.true;
      const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
      expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(
        subDaoAcc.onboardingDcFee.toNumber()
      );
    });

    it("updates entity config", async () => {
      const { rewardableEntityConfig } = await initTestRewardableEntityConfig(
        hemProgram,
        subDao
      );

      await hemProgram.methods
        .updateRewardableEntityConfigV0({
          newAuthority: PublicKey.default,
          settings: null,
          stakingRequirement: null,
        })
        .accounts({
          rewardableEntityConfig,
        })
        .rpc();

      const acc = await hemProgram.account.rewardableEntityConfigV0.fetch(
        rewardableEntityConfig
      );
      expect(acc.authority.toBase58()).to.equal(PublicKey.default.toBase58());
    });

    describe("with hotspot", () => {
      let infoKey: PublicKey | undefined;
      beforeEach(async () => {
        await hemProgram.methods
          .issueEntityV0({
            entityKey: Buffer.from(bs58.decode(ecc)),
          })
          .preInstructions([
            ComputeBudgetProgram.setComputeUnitLimit({ units: 350000 }),
          ])
          .accounts({
            maker,
            dao,
            recipient: hotspotOwner.publicKey,
            issuingAuthority: makerKeypair.publicKey,
            eccVerifier: eccVerifier.publicKey,
          })
          .signers([makerKeypair, eccVerifier])
          .rpc({ skipPreflight: true });

        const method = (
          await onboardIotHotspot({
            program: hemProgram,
            assetId: hotspot,
            maker,
            dao,
            location: new BN(100),
            rewardableEntityConfig,
            getAssetFn,
            getAssetProofFn,
          })
        ).signers([makerKeypair, hotspotOwner]);
        ({ iotInfo: infoKey } = await method.pubkeys());

        await method.rpc({ skipPreflight: true });

        await dcProgram.methods
          .mintDataCreditsV0({
            hntAmount: toBN(startDcBal, 8),
            dcAmount: null,
          })
          .accounts({ dcMint, recipient: hotspotOwner.publicKey })
          .rpc();
      });

      it("oracle can update active status", async () => {
        await hemProgram.methods
          .setEntityActiveV0({
            isActive: false,
            entityKey: Buffer.from(bs58.decode(ecc)),
          })
          .accounts({
            activeDeviceAuthority: activeDeviceAuthority.publicKey,
            rewardableEntityConfig,
            info: infoKey!,
          })
          .signers([activeDeviceAuthority])
          .rpc({ skipPreflight: true });

        console.log(infoKey);
        const infoAcc = await hemProgram.account.iotHotspotInfoV0.fetch(
          infoKey!
        );
        expect(infoAcc.isActive).to.be.false;
        const subDaoAcc = await hsdProgram.account.subDaoV0.fetch(subDao);
        expect(subDaoAcc.dcOnboardingFeesPaid.toNumber()).to.be.eq(5000000);
      });

      it("changes the metadata", async () => {
        const location = new BN(1000);
        const elevation = 100;
        const gain = 100;

        const method = (
          await updateIotMetadata({
            program: hemProgram,
            assetId: hotspot,
            rewardableEntityConfig,
            location,
            elevation,
            gain,
            getAssetFn,
            getAssetProofFn,
          })
        ).signers([hotspotOwner]);

        const info = (await method.pubkeys()).iotInfo!;
        await method.rpc({ skipPreflight: true });

        const storageAcc = await hemProgram.account.iotHotspotInfoV0.fetch(
          info!
        );
        expect(storageAcc.location?.toNumber()).to.eq(location.toNumber());
        expect(storageAcc.elevation).to.eq(elevation);
        expect(storageAcc.gain).to.eq(gain);
      });

      it("updates maker", async () => {
        await hemProgram.methods
          .updateMakerV0({
            updateAuthority: PublicKey.default,
            issuingAuthority: PublicKey.default,
          })
          .accounts({
            maker,
            updateAuthority: makerKeypair.publicKey,
          })
          .signers([makerKeypair])
          .rpc();

        const acc = await hemProgram.account.makerV0.fetch(maker);
        expect(acc.issuingAuthority.toBase58()).to.eq(
          PublicKey.default.toBase58()
        );
        expect(acc.updateAuthority.toBase58()).to.eq(
          PublicKey.default.toBase58()
        );
      });

      it("doesn't assert gain outside range", async () => {
        const method = (
          await updateIotMetadata({
            program: hemProgram,
            assetId: hotspot,
            location: null,
            elevation: null,
            gain: 1,
            rewardableEntityConfig,
            getAssetFn,
            getAssetProofFn,
          })
        ).signers([hotspotOwner]);

        // @ts-ignore
        expect(method.rpc()).to.be.rejected;

        const method2 = (
          await updateIotMetadata({
            program: hemProgram,
            assetId: hotspot,
            location: null,
            elevation: null,
            gain: 1000,
            rewardableEntityConfig,
            getAssetFn,
            getAssetProofFn,
          })
        ).signers([hotspotOwner]);

        // @ts-ignore
        expect(method2.rpc()).to.be.rejected;
      });
    });
  });
});
