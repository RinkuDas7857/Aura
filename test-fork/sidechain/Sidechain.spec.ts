import { expect } from "chai";
import { Signer } from "ethers";
import hre, { ethers, network } from "hardhat";

import { SimplyBridgeDelegateDeployed } from "../../scripts/deployBridgeDelegates";
import {
    CanonicalPhase1Deployed,
    CanonicalPhase2Deployed,
    SidechainPhase1Deployed,
    SidechainPhase2Deployed,
} from "../../scripts/deploySidechain";
import { config as arbitrumConfig } from "../../tasks/deploy/arbitrum-config";
import { config as mainnetConfig } from "../../tasks/deploy/mainnet-config";
import { lzChainIds } from "../../tasks/deploy/sidechain-constants";
import { impersonate, impersonateAccount, ONE_DAY, simpleToExactAmount, ZERO_ADDRESS } from "../../test-utils";
import {
    Account,
    AuraOFT,
    BaseRewardPool4626__factory,
    BaseRewardPool__factory,
    ERC20,
    ERC20__factory,
    ExtraRewardStashV3__factory,
    L2Coordinator,
    LZEndpointMock,
    MockERC20__factory,
    SidechainConfig,
} from "../../types";
import { increaseTime } from "./../../test-utils/time";
import { setupForkDeployment, TestSuiteDeployment } from "./setupForkDeployments";
import { setupLocalDeployment } from "./setupLocalDeployment";

const FORKING = process.env.FORKING;

const [_canonicalConfig, _sidechainConfig, BLOCK_NUMBER, NATIVE_FEE] = FORKING
    ? [mainnetConfig, arbitrumConfig, 101362532, simpleToExactAmount("0.2")]
    : [mainnetConfig, mainnetConfig, 17337285, simpleToExactAmount("0.2")];

const canonicalConfig = _canonicalConfig as typeof mainnetConfig;
const sidechainConfigGlobal = _sidechainConfig as SidechainConfig;

const canonicalLzChainId = lzChainIds[canonicalConfig.chainId];
const sidechainLzChainId = lzChainIds[sidechainConfigGlobal.chainId];

describe("Sidechain", () => {
    let alice: Signer;
    let aliceAddress: string;
    let deployer: Account;
    let notAuthorised: Account;
    let dao: Account;
    // LayerZero endpoints
    let l2LzEndpoint: LZEndpointMock;
    let crv: ERC20;
    let sidechain: SidechainPhase1Deployed & SidechainPhase2Deployed;
    let sidechainConfig: SidechainConfig;
    let l2Coordinator: L2Coordinator;
    let auraOFT: AuraOFT;
    let canonical: CanonicalPhase1Deployed & CanonicalPhase2Deployed;
    let bridgeDelegateDeployment: SimplyBridgeDelegateDeployed;

    /* ---------------------------------------------------------------------
     * Helper Functions
     * --------------------------------------------------------------------- */

    const getBpt = async (token: string, recipient: string, amount = simpleToExactAmount(250)) => {
        const whale = sidechainConfig.whales[token.toLowerCase()];
        if (!whale) throw new Error(`No BPT whale found for ${token}`);
        const tokenWhaleSigner = await impersonateAccount(whale, true);
        const tokenContract = MockERC20__factory.connect(token, tokenWhaleSigner.signer);
        await tokenContract.transfer(recipient, amount);
    };

    before(async () => {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.NODE_URL,
                        blockNumber: BLOCK_NUMBER,
                    },
                },
            ],
        });

        const accounts = await ethers.getSigners();
        alice = accounts[1];
        aliceAddress = await alice.getAddress();
        deployer = await impersonateAccount(sidechainConfigGlobal.multisigs.daoMultisig, true);
        notAuthorised = await impersonateAccount(await accounts[3].getAddress());

        let result: TestSuiteDeployment;
        if (FORKING) {
            result = await setupForkDeployment(
                hre,
                canonicalConfig,
                sidechainConfigGlobal,
                deployer,
                sidechainLzChainId,
                { deployBridgeSender: true },
            );
        } else {
            result = await setupLocalDeployment(hre, canonicalConfig, deployer, canonicalLzChainId, sidechainLzChainId);
        }

        l2LzEndpoint = result.l2LzEndpoint;
        canonical = result.canonical;
        sidechain = result.sidechain;
        bridgeDelegateDeployment = result.bridgeDelegateDeployment;
        dao = await impersonateAccount(sidechainConfigGlobal.multisigs.daoMultisig);
        l2Coordinator = sidechain.l2Coordinator;
        auraOFT = sidechain.auraOFT;
        sidechainConfig = result.sidechainConfig;
        crv = ERC20__factory.connect(sidechainConfig.extConfig.token, alice);
    });

    describe("Check configs", () => {
        it("VotingProxy has correct config", async () => {
            const { extConfig } = sidechainConfig;

            expect(await sidechain.voterProxy.mintr()).eq(extConfig.minter);
            expect(await sidechain.voterProxy.crv()).eq(extConfig.token);
            expect(await sidechain.voterProxy.rewardDeposit()).eq(ZERO_ADDRESS);
            expect(await sidechain.voterProxy.withdrawer()).eq(ZERO_ADDRESS);
            expect(await sidechain.voterProxy.owner()).eq(dao.address);
            expect(await sidechain.voterProxy.operator()).eq(sidechain.booster.address);
        });
        it("AuraOFT has correct config", async () => {
            expect(await auraOFT.name()).eq(sidechainConfig.naming.auraOftName);
            expect(await auraOFT.symbol()).eq(sidechainConfig.naming.auraOftSymbol);
            expect(await auraOFT.lzEndpoint()).eq(sidechainConfig.extConfig.lzEndpoint);
            expect(await auraOFT.canonicalChainId()).eq(canonicalLzChainId);
            expect(await auraOFT.guardian()).eq(sidechainConfig.multisigs.pauseGuardian);
        });
        it("AuraOFT has correct config", async () => {
            expect(await sidechain.auraBalOFT.name()).eq(sidechainConfig.naming.auraBalOftName);
            expect(await sidechain.auraBalOFT.symbol()).eq(sidechainConfig.naming.auraBalOftSymbol);
            expect(await sidechain.auraBalOFT.lzEndpoint()).eq(sidechainConfig.extConfig.lzEndpoint);
            expect(await sidechain.auraBalOFT.guardian()).eq(sidechainConfig.multisigs.pauseGuardian);
        });
        it("L2Coordinator has correct config", async () => {
            expect(await l2Coordinator.canonicalChainId()).eq(canonicalLzChainId);
            expect(await l2Coordinator.booster()).eq(sidechain.booster.address);
            expect(await l2Coordinator.auraOFT()).eq(auraOFT.address);
            expect(await l2Coordinator.mintRate()).eq(0);
            expect(await l2Coordinator.lzEndpoint()).eq(sidechainConfig.extConfig.lzEndpoint);
        });
        it("BoosterLite has correct config", async () => {
            expect(await sidechain.booster.crv()).eq(sidechainConfig.extConfig.token);

            expect(await sidechain.booster.lockIncentive()).eq(1850);
            expect(await sidechain.booster.stakerIncentive()).eq(400);
            expect(await sidechain.booster.earmarkIncentive()).eq(50);
            expect(await sidechain.booster.platformFee()).eq(200);
            expect(await sidechain.booster.MaxFees()).eq(4000);
            expect(await sidechain.booster.FEE_DENOMINATOR()).eq(10000);

            expect(await sidechain.booster.owner()).eq(sidechain.boosterOwner.address);
            expect(await sidechain.booster.feeManager()).eq(dao.address);
            expect(await sidechain.booster.poolManager()).eq(sidechain.poolManager.address);
            expect(await sidechain.booster.staker()).eq(sidechain.voterProxy.address);
            expect(await sidechain.booster.minter()).eq(l2Coordinator.address);
            expect(await sidechain.booster.rewardFactory()).eq(sidechain.factories.rewardFactory.address);
            expect(await sidechain.booster.stashFactory()).eq(sidechain.factories.stashFactory.address);
            expect(await sidechain.booster.tokenFactory()).eq(sidechain.factories.tokenFactory.address);
            expect(await sidechain.booster.treasury()).eq(ZERO_ADDRESS);

            expect(await sidechain.booster.isShutdown()).eq(false);
            expect(await sidechain.booster.poolLength()).eq(0);
        });
        it("Booster Owner has correct config", async () => {
            expect(await sidechain.boosterOwner.poolManager()).eq(sidechain.poolManager.address);
            expect(await sidechain.boosterOwner.booster()).eq(sidechain.booster.address);
            expect(await sidechain.boosterOwner.stashFactory()).eq(sidechain.factories.stashFactory.address);
            expect(await sidechain.boosterOwner.rescueStash()).eq(ZERO_ADDRESS);
            expect(await sidechain.boosterOwner.owner()).eq(dao.address);
            expect(await sidechain.boosterOwner.pendingowner()).eq(ZERO_ADDRESS);
            expect(await sidechain.boosterOwner.isSealed()).eq(true);
            expect(await sidechain.boosterOwner.isForceTimerStarted()).eq(false);
            expect(await sidechain.boosterOwner.forceTimestamp()).eq(0);
        });
        it("factories have correct config", async () => {
            const {
                booster,
                factories: { rewardFactory, stashFactory, tokenFactory, proxyFactory },
            } = sidechain;

            const { extConfig } = sidechainConfig;

            expect(await rewardFactory.operator()).eq(booster.address);
            expect(await rewardFactory.crv()).eq(extConfig.token);

            expect(await stashFactory.operator()).eq(booster.address);
            expect(await stashFactory.rewardFactory()).eq(rewardFactory.address);
            expect(await stashFactory.proxyFactory()).eq(proxyFactory.address);
            expect(await stashFactory.v1Implementation()).eq(ZERO_ADDRESS);
            expect(await stashFactory.v2Implementation()).eq(ZERO_ADDRESS);

            const rewardsStashV3 = ExtraRewardStashV3__factory.connect(
                await stashFactory.v3Implementation(),
                deployer.signer,
            );
            expect(await rewardsStashV3.crv()).eq(extConfig.token);

            expect(await tokenFactory.operator()).eq(booster.address);
            expect(await tokenFactory.namePostfix()).eq(sidechainConfig.naming.tokenFactoryNamePostfix);
            expect(await tokenFactory.symbolPrefix()).eq("aura");
        });
        it("poolManager has correct config", async () => {
            const { booster, poolManager } = sidechain;
            expect(await poolManager.booster()).eq(booster.address);
            expect(await poolManager.operator()).eq(dao.address);
        });
    });

    /* ---------------------------------------------------------------------
     * General Functional tests
     * --------------------------------------------------------------------- */

    describe("Booster setup", () => {
        it("add pools to the booster", async () => {
            // As this test suite is running the bridge from L1 -> L1 forked on
            // mainnet. We can just add the first 10 active existing Aura pools
            for (let i = 1; i < sidechainConfig.extConfig.gauges.length - 1; i++) {
                await sidechain.poolManager
                    .connect(dao.signer)
                    ["addPool(address)"](sidechainConfig.extConfig.gauges[i]);
            }
        });
        it("Pool stash has the correct config", async () => {
            const pool0 = await sidechain.booster.poolInfo(0);
            const stash = ExtraRewardStashV3__factory.connect(pool0.stash, deployer.signer);
            expect(await stash.pid()).eq(0);
            expect(await stash.operator()).eq(sidechain.booster.address);
            expect(await stash.staker()).eq(sidechain.voterProxy.address);
            expect(await stash.gauge()).eq(pool0.gauge);
            expect(await stash.rewardFactory()).eq(sidechain.factories.rewardFactory.address);
            expect(await stash.hasRedirected()).eq(false); //Todo: verify if this is actually meant to be true or false
            expect(await stash.hasCurveRewards()).eq(false);
            await expect(stash.tokenList(0)).to.be.reverted;
        });
        it("Pool rewards contract has the correct config", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            const rewardContract = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, deployer.signer);
            await expect(rewardContract.extraRewards(0)).to.be.reverted;
        });
        it("Delegates are set up", async () => {
            let owner = await impersonateAccount(await sidechain.l2Coordinator.owner());
            await sidechain.l2Coordinator
                .connect(owner.signer)
                .setBridgeDelegate(bridgeDelegateDeployment.bridgeDelegateSender.address);

            owner = await impersonateAccount(await bridgeDelegateDeployment.bridgeDelegateSender.owner());

            expect(await sidechain.l2Coordinator.bridgeDelegate()).to.eq(
                bridgeDelegateDeployment.bridgeDelegateSender.address,
            );
        });
        it("add trusted remotes to layerzero endpoints", async () => {
            const owner = await impersonateAccount(await sidechain.l2Coordinator.owner());

            await sidechain.l2Coordinator
                .connect(owner.signer)
                .setTrustedRemote(
                    canonicalLzChainId,
                    ethers.utils.solidityPack(
                        ["address", "address"],
                        [canonical.l1Coordinator.address, sidechain.l2Coordinator.address],
                    ),
                );

            await sidechain.auraOFT
                .connect(owner.signer)
                .setTrustedRemote(
                    canonicalLzChainId,
                    ethers.utils.solidityPack(
                        ["address", "address"],
                        [canonical.auraProxyOFT.address, sidechain.auraOFT.address],
                    ),
                );

            await sidechain.auraBalOFT
                .connect(owner.signer)
                .setTrustedRemote(
                    canonicalLzChainId,
                    ethers.utils.solidityPack(
                        ["address", "address"],
                        [canonical.auraBalProxyOFT.address, sidechain.auraBalOFT.address],
                    ),
                );
        });
    });

    describe("Setup L2 Coordinator to be able to mint rewards", () => {
        it("Can send a payload to set the mint rate", async () => {
            const endpoint = await impersonateAccount(await sidechain.l2Coordinator.lzEndpoint());
            const accAuraRewardsBefore = await sidechain.l2Coordinator.accAuraRewards();

            const amount = simpleToExactAmount(1);

            const payload = ethers.utils.defaultAbiCoder.encode(
                ["bytes4", "uint8", "uint256"],
                ["0x7a7f9946", "2", amount],
            );
            await sidechain.l2Coordinator
                .connect(endpoint.signer)
                .lzReceive(
                    canonicalLzChainId,
                    await sidechain.l2Coordinator.trustedRemoteLookup(canonicalLzChainId),
                    0,
                    payload,
                );

            const accAuraRewardsAfter = await sidechain.l2Coordinator.accAuraRewards();
            expect(accAuraRewardsAfter.sub(accAuraRewardsBefore)).eq(amount);
        });
        it("Mint and send aura to l2 coordinator", async () => {
            // Transfer some AURA to L2
            const bridgeAmount = ethers.utils.parseEther("10000");

            // bytes memory lzPayload = abi.encode(PT_SEND, _toAddress, amount);
            const PT_SEND = await sidechain.auraOFT.PT_SEND();
            const toAddress = ethers.utils.solidityPack(["address"], [l2Coordinator.address]);
            const payload = ethers.utils.defaultAbiCoder.encode(
                ["uint16", "bytes", "uint256"],
                [PT_SEND, toAddress, bridgeAmount],
            );

            const signer = await impersonate(sidechain.auraOFT.address, true);
            await sidechain.auraOFT
                .connect(signer)
                .nonblockingLzReceive(canonicalLzChainId, l2LzEndpoint.address, 0, payload);
        });
    });

    describe("Deposit and withdraw BPT", () => {
        it("allow deposit into pool via Booster", async () => {
            const poolId = 0;
            const poolInfo = await sidechain.booster.poolInfo(poolId);
            const amount = ethers.utils.parseEther("1");
            await getBpt(poolInfo.lptoken, aliceAddress, amount);

            const depositToken = ERC20__factory.connect(poolInfo.token, alice);
            const lptoken = MockERC20__factory.connect(poolInfo.lptoken, alice);

            await lptoken.approve(sidechain.booster.address, amount);

            const depositTokenBalanceBefore = await depositToken.balanceOf(aliceAddress);
            const lptokenBalanceBefore = await lptoken.balanceOf(aliceAddress);
            expect(lptokenBalanceBefore).gt(0);

            await sidechain.booster.connect(alice).depositAll(0, false);

            const lptokenBalanceAfter = await lptoken.balanceOf(aliceAddress);
            const depositTokenBalanceAfter = await depositToken.balanceOf(aliceAddress);
            expect(lptokenBalanceAfter).eq(0);
            expect(depositTokenBalanceAfter.sub(depositTokenBalanceBefore)).eq(lptokenBalanceBefore);
        });
        it("allows auraBPT deposits directly into the reward pool", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);

            const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, alice);
            const depositToken = ERC20__factory.connect(poolInfo.token, alice);
            const balance = await depositToken.balanceOf(aliceAddress);

            const rewardBalanceBefore = await rewards.balanceOf(aliceAddress);
            await depositToken.approve(rewards.address, balance);
            await rewards.stake(balance);
            const rewardBalanceAfter = await rewards.balanceOf(aliceAddress);
            expect(rewardBalanceAfter.sub(rewardBalanceBefore)).eq(balance);
        });
        it("allows BPT deposits directly into the reward pool", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            await getBpt(poolInfo.lptoken, aliceAddress, simpleToExactAmount(10));

            const lpToken = ERC20__factory.connect(poolInfo.lptoken, alice);
            const baseRewardPool = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, alice);

            const lpTokenBalance = await lpToken.balanceOf(aliceAddress);

            const rewardBalanceBefore = await baseRewardPool.balanceOf(aliceAddress);

            await lpToken.approve(baseRewardPool.address, lpTokenBalance);
            await baseRewardPool.deposit(lpTokenBalance, aliceAddress);
            const rewardBalanceAfter = await baseRewardPool.balanceOf(aliceAddress);

            expect(rewardBalanceAfter.sub(rewardBalanceBefore)).eq;
        });
        it("allows withdrawals directly from the pool 4626", async () => {
            const amount = simpleToExactAmount(1);
            const poolInfo = await sidechain.booster.poolInfo(0);

            const rewards = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, alice);
            const lptoken = ERC20__factory.connect(poolInfo.lptoken, alice);
            const balanceBefore = await lptoken.balanceOf(aliceAddress);

            await rewards["withdraw(uint256,address,address)"](amount, aliceAddress, aliceAddress);

            const balanceAfter = await lptoken.balanceOf(aliceAddress);
            expect(balanceAfter.sub(balanceBefore)).eq(amount);
        });
        it("allows withdrawals directly from the pool normal", async () => {
            const amount = simpleToExactAmount(1);
            const poolInfo = await sidechain.booster.poolInfo(0);

            const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, alice);
            const depositToken = ERC20__factory.connect(poolInfo.token, alice);
            const balanceBefore = await depositToken.balanceOf(aliceAddress);

            await rewards.withdraw(amount, false);

            const balanceAfter = await depositToken.balanceOf(aliceAddress);
            expect(balanceAfter.sub(balanceBefore)).eq(amount);
        });
        it("allows earmarking of rewards", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            const crvRewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, dao.signer);
            const balanceBefore = await crv.balanceOf(crvRewards.address);
            await increaseTime(ONE_DAY);
            await sidechain.booster.connect(alice).earmarkRewards(0, ZERO_ADDRESS, { value: NATIVE_FEE });
            const balanceAfter = await crv.balanceOf(crvRewards.address);
            expect(balanceAfter).gt(balanceBefore);
        });
        it("pays out a premium to the caller", async () => {
            const balanceBefore = await crv.balanceOf(aliceAddress);
            await increaseTime(ONE_DAY);
            await sidechain.booster.connect(alice).earmarkRewards(0, ZERO_ADDRESS, { value: NATIVE_FEE });
            const balanceAfter = await crv.balanceOf(aliceAddress);
            expect(balanceAfter).gt(balanceBefore);
        });
        it("allows users to earn $BAl and $AURA", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, alice);
            const cvxBalanceBefore = await sidechain.auraOFT.balanceOf(aliceAddress);
            const crvBalanceBefore = await crv.balanceOf(aliceAddress);

            //forward time and harvest
            for (let i = 0; i < 7; i++) {
                await increaseTime(ONE_DAY);
                await increaseTime(ONE_DAY);
                await sidechain.booster.connect(dao.signer).earmarkRewards(0, ZERO_ADDRESS, { value: NATIVE_FEE });
            }

            const earned = await rewards.earned(aliceAddress);
            await rewards["getReward(address,bool)"](aliceAddress, true);
            const cvxBalanceAfter = await sidechain.auraOFT.balanceOf(aliceAddress);
            const crvBalanceAfter = await crv.balanceOf(aliceAddress);

            const crvBalance = crvBalanceAfter.sub(crvBalanceBefore);
            const cvxBalance = cvxBalanceAfter.sub(cvxBalanceBefore);

            expect(crvBalance).gte(earned);
            expect(cvxBalance).gt(0);
        });
        it("allows extra rewards to be added to pool", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            const stash = ExtraRewardStashV3__factory.connect(poolInfo.stash, deployer.signer);
            const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, deployer.signer);

            const extraLenBefore = await rewards.extraRewardsLength();
            await sidechain.boosterOwner.setStashExtraReward(stash.address, sidechain.auraOFT.address);
            const extraLenAfter = await rewards.extraRewardsLength();
            expect(extraLenAfter.sub(extraLenBefore)).to.eq(1);
        });
    });

    describe("Booster admin", () => {
        it("does not allow a duplicate pool to be added", async () => {
            const poolInfo = await sidechain.booster.poolInfo(0);
            await expect(
                sidechain.poolManager.connect(dao.signer)["addPool(address)"](poolInfo.gauge),
            ).to.be.revertedWith("already registered gauge");
        });
        it("allows a pool to be shut down", async () => {
            await sidechain.poolManager.connect(dao.signer).shutdownPool(0);
            const poolInfo = await sidechain.booster.poolInfo(0);
            expect(poolInfo.shutdown).to.eq(true);
        });
        it("does not allow the system to be shut down", async () => {
            await expect(sidechain.boosterOwner.connect(dao.signer).shutdownSystem()).to.be.revertedWith(
                "!poolMgrShutdown",
            );
        });
        it("allows boosterOwner owner to be changed", async () => {
            const accounts = await ethers.getSigners();
            const newOwner = await impersonateAccount(await accounts[2].getAddress());
            let owner = await sidechain.boosterOwner.owner();
            expect(owner).eq(dao.address);

            await sidechain.boosterOwner.connect(dao.signer).transferOwnership(newOwner.address);
            owner = await sidechain.boosterOwner.owner();
            expect(owner).eq(dao.address);
            let pendingOwner = await sidechain.boosterOwner.pendingowner();
            expect(pendingOwner).eq(newOwner.address);

            await expect(sidechain.boosterOwner.connect(dao.signer).acceptOwnership()).to.be.revertedWith(
                "!pendingowner",
            );

            await sidechain.boosterOwner.connect(newOwner.signer).acceptOwnership();
            owner = await sidechain.boosterOwner.owner();
            expect(owner).eq(newOwner.address);
            pendingOwner = await sidechain.boosterOwner.pendingowner();
            expect(pendingOwner).eq(ZERO_ADDRESS);

            await sidechain.boosterOwner.connect(newOwner.signer).transferOwnership(dao.address);
            await sidechain.boosterOwner.connect(dao.signer).acceptOwnership();
        });
        it("allows boosterOwner to call all fns on booster", async () => {
            await sidechain.boosterOwner.connect(dao.signer).setFeeManager(mainnetConfig.multisigs.treasuryMultisig);
            expect(await sidechain.booster.feeManager()).eq(mainnetConfig.multisigs.treasuryMultisig);
            await sidechain.boosterOwner.connect(dao.signer).setFeeManager(dao.address);

            await sidechain.boosterOwner.connect(dao.signer).setFactories(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS);
            expect(await sidechain.booster.stashFactory()).eq(ZERO_ADDRESS);
            expect(await sidechain.booster.tokenFactory()).not.eq(ZERO_ADDRESS);
            expect(await sidechain.booster.rewardFactory()).not.eq(ZERO_ADDRESS);
        });
    });

    describe("Shutdown", () => {
        it("allows system to be shutdown", async () => {
            const daoMultisig = await impersonateAccount(await sidechain.boosterOwner.owner());
            const poolLength = await sidechain.booster.poolLength();

            for (let i = 0; i < poolLength.toNumber(); i++) {
                const poolInfoBefore = await sidechain.booster.poolInfo(i);
                if (poolInfoBefore.shutdown) {
                    continue;
                }

                await sidechain.poolManager.connect(daoMultisig.signer).shutdownPool(i);
                const poolInfo = await sidechain.booster.poolInfo(i);
                expect(poolInfo.shutdown).to.eq(true);
            }

            await sidechain.poolManager.connect(daoMultisig.signer).shutdownSystem();
            await sidechain.boosterOwner.connect(daoMultisig.signer).shutdownSystem();

            expect(await sidechain.booster.isShutdown()).to.eq(true);
            expect(await sidechain.poolManager.isShutdown()).to.eq(true);
        });
    });

    /* ---------------------------------------------------------------------
     * Protected functions
     * --------------------------------------------------------------------- */

    describe("Protected functions", () => {
        it("PoolManager protected functions", async () => {
            await expect(sidechain.poolManager.connect(notAuthorised.signer).shutdownPool(0)).to.revertedWith("!auth");
            await expect(
                sidechain.poolManager.connect(notAuthorised.signer).setOperator(notAuthorised.address),
            ).to.revertedWith("!auth");
        });
        it("booster protected functions", async () => {
            await expect(sidechain.booster.connect(notAuthorised.signer).shutdownPool(0)).to.be.revertedWith("!auth");
            await expect(sidechain.booster.connect(notAuthorised.signer).shutdownSystem()).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setTreasury(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster
                    .connect(notAuthorised.signer)
                    .setFactories(notAuthorised.address, notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setFeeManager(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setOwner(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setRewardContracts(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setFees(100, 100, 100, 100),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.booster.connect(notAuthorised.signer).setPoolManager(notAuthorised.address),
            ).to.be.revertedWith("!auth");
        });
        it("voterProxy protected functions", async () => {
            await expect(
                sidechain.voterProxy.connect(notAuthorised.signer).setOwner(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.voterProxy.connect(notAuthorised.signer).setOperator(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.voterProxy
                    .connect(notAuthorised.signer)
                    .setRewardDeposit(notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.voterProxy.connect(notAuthorised.signer).setStashAccess(notAuthorised.address, false),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.voterProxy.connect(notAuthorised.signer).setSystemConfig(notAuthorised.address),
            ).to.be.revertedWith("!auth");
            await expect(
                sidechain.voterProxy.connect(notAuthorised.signer).execute(notAuthorised.address, 0, "0x00"),
            ).to.be.revertedWith("!auth");
        });

        it("boosterOwner protected functions", async () => {
            await expect(sidechain.boosterOwner.connect(notAuthorised.signer).shutdownSystem()).to.be.revertedWith(
                "!owner",
            );
            await expect(
                sidechain.boosterOwner
                    .connect(notAuthorised.signer)
                    .setStashRewardHook(notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!owner");
            await expect(sidechain.boosterOwner.connect(notAuthorised.signer).setBoosterOwner()).to.be.revertedWith(
                "!owner",
            );

            await expect(sidechain.boosterOwner.connect(notAuthorised.signer).sealOwnership()).to.be.revertedWith(
                "!owner",
            );
            await expect(
                sidechain.boosterOwner.connect(notAuthorised.signer).setFeeManager(notAuthorised.address),
            ).to.be.revertedWith("!owner");
            await expect(
                sidechain.boosterOwner
                    .connect(notAuthorised.signer)
                    .setFactories(notAuthorised.address, notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!owner");
            await expect(sidechain.boosterOwner.connect(notAuthorised.signer).queueForceShutdown()).to.be.revertedWith(
                "!owner",
            );
            await expect(
                sidechain.boosterOwner
                    .connect(notAuthorised.signer)
                    .setRescueTokenDistribution(notAuthorised.address, notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!owner");
            await expect(
                sidechain.boosterOwner
                    .connect(notAuthorised.signer)
                    .setStashExtraReward(notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!owner");
            await expect(
                sidechain.boosterOwner
                    .connect(notAuthorised.signer)
                    .setStashFactoryImplementation(notAuthorised.address, notAuthorised.address, notAuthorised.address),
            ).to.be.revertedWith("!owner");
        });
    });
});
