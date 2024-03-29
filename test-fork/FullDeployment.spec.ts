import { hashMessage } from "@ethersproject/hash";
import hre, { network } from "hardhat";
import { expect } from "chai";
import {
    IERC20__factory,
    ILBP,
    ILBP__factory,
    MockERC20__factory,
    IBalancerVault,
    IBalancerVault__factory,
    ERC20,
    ERC20__factory,
    IBalancerPool__factory,
    ExtraRewardStashV3__factory,
    BaseRewardPool4626__factory,
    BaseRewardPool__factory,
    MockFeeDistributor,
    MockFeeDistributor__factory,
    MockVoting__factory,
    VirtualBalanceRewardPool__factory,
    MockCurveGauge__factory,
} from "../types/generated";
import {
    impersonate,
    impersonateAccount,
    ZERO_ADDRESS,
    BN,
    ONE_WEEK,
    ONE_HOUR,
    assertBNClosePercent,
    assertBNClose,
    simpleToExactAmount,
    ONE_DAY,
    ZERO_KEY,
} from "../test-utils";
import { Signer } from "ethers";
import { deployContract, waitForTx } from "../tasks/utils";
import { getTimestamp, latestBlock, increaseTime, advanceBlock } from "./../test-utils/time";
import { deployPhase3, deployPhase4, Phase2Deployed, Phase3Deployed, SystemDeployed } from "../scripts/deploySystem";
import { Account } from "./../types/common";
import { config } from "../tasks/deploy/mainnet-config";
import { AssetHelpers, SwapKind, WeightedPoolExitKind } from "@balancer-labs/balancer-js";
import { ethers } from "ethers";

const debug = false;

const merkleDropRootHashes = ["0xdbfebc726c41a2647b8cf9ad7a770535e1fc3b8900e752147f7e14848720fe78", ZERO_KEY];

const testAccounts = {
    swapper: "0x0000000000000000000000000000000000000002",
    alice: "0x0000000000000000000000000000000000000003",
    eoa: "0x0000000000000000000000000000000000000004",
    staker: "0x0000000000000000000000000000000000000006",
};

xdescribe("Full Deployment", () => {
    let deployer: Signer;
    let deployerAddress: string;
    const phase2Timestamp = BN.from(1654772222);
    let phase2: Phase2Deployed;
    let phase3: Phase3Deployed;
    let phase4: SystemDeployed;

    before(async () => {
        await network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.NODE_URL,
                        blockNumber: 14932468,
                    },
                },
            ],
        });
        deployerAddress = "0xA28ea848801da877E1844F954FF388e857d405e5";
        deployer = await impersonate(deployerAddress);
    });

    const getCrv = async (recipient: string, amount = simpleToExactAmount(250)) => {
        await getEth(config.addresses.balancerVault);

        const tokenWhaleSigner = await impersonateAccount(config.addresses.balancerVault);
        const crv = MockERC20__factory.connect(config.addresses.token, tokenWhaleSigner.signer);
        const tx = await crv.transfer(recipient, amount);
        await waitForTx(tx, debug);
    };

    const getCrvBpt = async (recipient: string, amount = simpleToExactAmount(250)) => {
        const tokenWhaleSigner = await impersonateAccount(config.addresses.tokenWhale);
        const crvBpt = MockERC20__factory.connect(config.addresses.tokenBpt, tokenWhaleSigner.signer);
        const tx = await crvBpt.transfer(recipient, amount);
        await waitForTx(tx, debug);
    };

    const getWeth = async (recipient: string, amount = simpleToExactAmount(100)) => {
        const wethWhaleSigner = await impersonateAccount(config.addresses.wethWhale);
        const weth = MockERC20__factory.connect(config.addresses.weth, wethWhaleSigner.signer);
        const tx = await weth.transfer(recipient, amount);
        await waitForTx(tx, debug);
    };

    const getLpToken = async (recipient: string, amount = simpleToExactAmount(10)) => {
        const lpWhaleSigner = await impersonateAccount(config.addresses.staBAL3Whale);
        const lp = MockERC20__factory.connect(config.addresses.staBAL3, lpWhaleSigner.signer);
        const tx = await lp.transfer(recipient, amount);
        await waitForTx(tx, debug);
    };

    const getLdo = async (recipient: string, amount = simpleToExactAmount(10)) => {
        const ldoWhale = await impersonateAccount(config.addresses.ldoWhale);
        const ldo = MockERC20__factory.connect(config.addresses.ldo, ldoWhale.signer);
        const tx = await ldo.transfer(recipient, amount);
        await waitForTx(tx, debug);
    };

    const getEth = async (recipient: string) => {
        const ethWhale = await impersonate(config.addresses.weth);
        await ethWhale.sendTransaction({
            to: recipient,
            value: simpleToExactAmount(1),
        });
    };

    describe("Phase 2", () => {
        describe("DEPLOY-Phase 2", () => {
            before(async () => {
                // PHASE 2
                phase2 = await config.getPhase2(deployer);
            });
            describe("verifying config", () => {
                it("VotingProxy has correct config", async () => {
                    const { voterProxy, booster, crvDepositor } = phase2;
                    const { multisigs, addresses } = config;

                    expect(await voterProxy.mintr()).eq(addresses.minter);
                    expect(await voterProxy.crv()).eq(addresses.token);
                    expect(await voterProxy.crvBpt()).eq(addresses.tokenBpt);
                    expect(await voterProxy.escrow()).eq(addresses.votingEscrow);
                    expect(await voterProxy.gaugeController()).eq(addresses.gaugeController);
                    expect(await voterProxy.rewardDeposit()).eq(ZERO_ADDRESS);
                    expect(await voterProxy.withdrawer()).eq(ZERO_ADDRESS);
                    expect(await voterProxy.owner()).eq(multisigs.daoMultisig);
                    expect(await voterProxy.operator()).eq(booster.address);
                    expect(await voterProxy.depositor()).eq(crvDepositor.address);
                });
                it("Aura Token has correct config", async () => {
                    const { cvx, minter, booster, voterProxy } = phase2;
                    expect(await cvx.operator()).eq(booster.address);
                    expect(await cvx.vecrvProxy()).eq(voterProxy.address);
                    expect(await cvx.minter()).eq(minter.address);
                    expect(await cvx.totalSupply()).eq(simpleToExactAmount(50000000));
                });
                it("Contracts have correct Aura balance", async () => {
                    const { cvx, initialCvxCrvStaking, balLiquidityProvider, drops, vestedEscrows, chef } = phase2;
                    const { addresses, distroList } = config;
                    expect(await cvx.totalSupply()).eq(simpleToExactAmount(50, 24));
                    expect(await cvx.balanceOf(chef.address)).eq(distroList.lpIncentives);
                    expect(await cvx.balanceOf(initialCvxCrvStaking.address)).eq(distroList.cvxCrvBootstrap);
                    expect(await cvx.balanceOf(addresses.balancerVault)).eq(distroList.lbp.tknAmount);
                    expect(await cvx.balanceOf(balLiquidityProvider.address)).eq(distroList.lbp.matching);

                    const dropBalances = await Promise.all(drops.map(a => cvx.balanceOf(a.address)));
                    const airdropSum = distroList.airdrops.reduce((p, c) => p.add(c.amount), BN.from(0));
                    expect(dropBalances.reduce((p, c) => p.add(c), BN.from(0))).eq(airdropSum);

                    const vestingBalances = await Promise.all(vestedEscrows.map(a => cvx.balanceOf(a.address)));
                    const vestingSum = distroList.vesting
                        .concat(distroList.immutableVesting)
                        .reduce(
                            (p, c) => p.add(c.recipients.reduce((p2, c2) => p2.add(c2.amount), BN.from(0))),
                            BN.from(0),
                        );
                    expect(vestingBalances.reduce((p, c) => p.add(c), BN.from(0))).eq(vestingSum);
                });
                it("Aura Minter has correct config", async () => {
                    const { minter, cvx } = phase2;
                    const { multisigs } = config;
                    expect(await minter.aura()).eq(cvx.address);
                    expect(await minter.owner()).eq(multisigs.daoMultisig);
                    const time = await getTimestamp();
                    expect(await minter.inflationProtectionTime()).gt(time.add(ONE_WEEK.mul(155)));
                });
                it("Booster has correct config", async () => {
                    const {
                        booster,
                        cvx,
                        voterProxy,
                        cvxStakingProxy,
                        cvxCrvRewards,
                        arbitratorVault,
                        factories,
                        boosterOwner,
                        poolManagerProxy,
                    } = phase2;
                    const { multisigs, addresses } = config;
                    expect(await booster.crv()).eq(addresses.token);
                    expect(await booster.voteOwnership()).eq(ZERO_ADDRESS);
                    expect(await booster.voteParameter()).eq(ZERO_ADDRESS);

                    expect(await booster.lockIncentive()).eq(550);
                    expect(await booster.stakerIncentive()).eq(1100);
                    expect(await booster.earmarkIncentive()).eq(50);
                    expect(await booster.platformFee()).eq(0);
                    expect(await booster.MaxFees()).eq(2500);
                    expect(await booster.FEE_DENOMINATOR()).eq(10000);

                    expect(await booster.owner()).eq(boosterOwner.address);
                    expect(await booster.feeManager()).eq(multisigs.daoMultisig);
                    expect(await booster.poolManager()).eq(poolManagerProxy.address);
                    expect(await booster.staker()).eq(voterProxy.address);
                    expect(await booster.minter()).eq(cvx.address);
                    expect(await booster.rewardFactory()).eq(factories.rewardFactory.address);
                    expect(await booster.stashFactory()).eq(factories.stashFactory.address);
                    expect(await booster.tokenFactory()).eq(factories.tokenFactory.address);
                    expect(await booster.rewardArbitrator()).eq(arbitratorVault.address);
                    expect(await booster.voteDelegate()).eq(multisigs.daoMultisig);
                    expect(await booster.treasury()).eq(ZERO_ADDRESS);
                    expect(await booster.stakerRewards()).eq(cvxStakingProxy.address);
                    expect(await booster.lockRewards()).eq(cvxCrvRewards.address);

                    expect(await booster.isShutdown()).eq(false);
                    expect(await booster.poolLength()).eq(0);
                });
                it("Booster Owner has correct config", async () => {
                    const { booster, boosterOwner, poolManagerSecondaryProxy, factories } = phase2;
                    const { multisigs } = config;

                    expect(await boosterOwner.poolManager()).eq(poolManagerSecondaryProxy.address);
                    expect(await boosterOwner.booster()).eq(booster.address);
                    expect(await boosterOwner.stashFactory()).eq(factories.stashFactory.address);
                    expect(await boosterOwner.rescueStash()).eq(ZERO_ADDRESS);
                    expect(await boosterOwner.owner()).eq(multisigs.daoMultisig);
                    expect(await boosterOwner.pendingowner()).eq(ZERO_ADDRESS);
                    expect(await boosterOwner.isSealed()).eq(true);
                    expect(await boosterOwner.isForceTimerStarted()).eq(false);
                    expect(await boosterOwner.forceTimestamp()).eq(0);
                });
                it("factories have correct config", async () => {
                    const { factories, booster } = phase2;
                    const { addresses } = config;
                    const { rewardFactory, stashFactory, tokenFactory, proxyFactory } = factories;

                    expect(await rewardFactory.operator()).eq(booster.address);
                    expect(await rewardFactory.crv()).eq(addresses.token);

                    expect(await stashFactory.operator()).eq(booster.address);
                    expect(await stashFactory.rewardFactory()).eq(rewardFactory.address);
                    expect(await stashFactory.proxyFactory()).eq(proxyFactory.address);
                    expect(await stashFactory.v1Implementation()).eq(ZERO_ADDRESS);
                    expect(await stashFactory.v2Implementation()).eq(ZERO_ADDRESS);

                    const rewardsStashV3 = ExtraRewardStashV3__factory.connect(
                        await stashFactory.v3Implementation(),
                        deployer,
                    );
                    expect(await rewardsStashV3.crv()).eq(addresses.token);

                    expect(await tokenFactory.operator()).eq(booster.address);
                    expect(await tokenFactory.namePostfix()).eq(" Aura Deposit");
                    expect(await tokenFactory.symbolPrefix()).eq("aura");
                });
                it("arbitrator vault has correct config", async () => {
                    const { arbitratorVault, booster } = phase2;
                    const { multisigs } = config;

                    expect(await arbitratorVault.operator()).eq(multisigs.daoMultisig);
                    expect(await arbitratorVault.depositor()).eq(booster.address);
                });
                it("CvxCrv has correct config", async () => {
                    const { cvxCrv, crvDepositor } = phase2;
                    const { naming } = config;
                    expect(await cvxCrv.operator()).eq(crvDepositor.address);
                    expect(await cvxCrv.name()).eq(naming.cvxCrvName);
                    expect(await cvxCrv.symbol()).eq(naming.cvxCrvSymbol);
                });
                it("CvxCrvRewards has correct config", async () => {
                    const { cvxCrvRewards, cvxCrv, factories, booster } = phase2;
                    const { addresses } = config;
                    expect(await cvxCrvRewards.rewardToken()).eq(addresses.token);
                    expect(await cvxCrvRewards.stakingToken()).eq(cvxCrv.address);
                    expect(await cvxCrvRewards.operator()).eq(booster.address);
                    expect(await cvxCrvRewards.rewardManager()).eq(factories.rewardFactory.address);
                    expect(await cvxCrvRewards.pid()).eq(0);
                    expect(await cvxCrvRewards.extraRewardsLength()).eq(0);
                });
                it("InitialCvxCrvStaking has correct config", async () => {
                    const { initialCvxCrvStaking, cvxLocker, cvx, cvxCrv, penaltyForwarder } = phase2;
                    const { multisigs } = config;
                    expect(await initialCvxCrvStaking.rewardToken()).eq(cvx.address);
                    expect(await initialCvxCrvStaking.stakingToken()).eq(cvxCrv.address);
                    expect(await initialCvxCrvStaking.duration()).eq(ONE_WEEK.mul(2));
                    expect(await initialCvxCrvStaking.rewardManager()).eq(multisigs.treasuryMultisig);
                    expect(await initialCvxCrvStaking.auraLocker()).eq(cvxLocker.address);
                    expect(await initialCvxCrvStaking.penaltyForwarder()).eq(penaltyForwarder.address);
                    expect(await initialCvxCrvStaking.pendingPenalty()).eq(0);

                    expect(await initialCvxCrvStaking.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await initialCvxCrvStaking.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                });
                it("CrvDepositor has correct config", async () => {
                    const { voterProxy, cvxCrv, crvDepositor } = phase2;
                    const { multisigs, addresses } = config;
                    expect(await crvDepositor.crvBpt()).eq(addresses.tokenBpt);
                    expect(await crvDepositor.escrow()).eq(addresses.votingEscrow);
                    expect(await crvDepositor.lockIncentive()).eq(10);
                    expect(await crvDepositor.feeManager()).eq(multisigs.daoMultisig);
                    expect(await crvDepositor.daoOperator()).eq(multisigs.daoMultisig);
                    expect(await crvDepositor.staker()).eq(voterProxy.address);
                    expect(await crvDepositor.minter()).eq(cvxCrv.address);
                    expect(await crvDepositor.incentiveCrv()).eq(0);
                    expect(await crvDepositor.cooldown()).eq(false);
                });
                it("crvDepositorWrapper has correct config", async () => {
                    const { crvDepositorWrapper, crvDepositor } = phase2;
                    const { addresses } = config;
                    expect(await crvDepositorWrapper.crvDeposit()).eq(crvDepositor.address);
                    expect(await crvDepositorWrapper.BALANCER_VAULT()).eq(addresses.balancerVault);
                    expect(await crvDepositorWrapper.BAL()).eq(addresses.token);
                    expect(await crvDepositorWrapper.WETH()).eq(addresses.weth);
                    expect(await crvDepositorWrapper.BAL_ETH_POOL_ID()).eq(addresses.balancerPoolId);
                });
                it("poolManagerProxy has correct config", async () => {
                    const { booster, poolManagerProxy, poolManagerSecondaryProxy } = phase2;
                    expect(await poolManagerProxy.pools()).eq(booster.address);
                    expect(await poolManagerProxy.owner()).eq(ZERO_ADDRESS);
                    expect(await poolManagerProxy.operator()).eq(poolManagerSecondaryProxy.address);
                });
                it("poolManagerSecondaryProxy has correct config", async () => {
                    const { booster, poolManagerProxy, poolManagerSecondaryProxy, poolManager } = phase2;
                    const { multisigs, addresses } = config;
                    expect(await poolManagerSecondaryProxy.gaugeController()).eq(addresses.gaugeController);
                    expect(await poolManagerSecondaryProxy.pools()).eq(poolManagerProxy.address);
                    expect(await poolManagerSecondaryProxy.booster()).eq(booster.address);
                    expect(await poolManagerSecondaryProxy.owner()).eq(multisigs.daoMultisig);
                    expect(await poolManagerSecondaryProxy.operator()).eq(poolManager.address);
                    expect(await poolManagerSecondaryProxy.isShutdown()).eq(false);
                });
                it("poolManager has correct config", async () => {
                    const { poolManagerSecondaryProxy, poolManager } = phase2;
                    const { multisigs, addresses } = config;
                    expect(await poolManager.pools()).eq(poolManagerSecondaryProxy.address);
                    expect(await poolManager.gaugeController()).eq(addresses.gaugeController);
                    expect(await poolManager.operator()).eq(multisigs.daoMultisig);
                    expect(await poolManager.protectAddPool()).eq(true);
                });
                it("Aura Locker has correct config", async () => {
                    const { cvxLocker, cvxCrv, cvxStakingProxy, cvx, cvxCrvRewards } = phase2;
                    const { naming, multisigs } = config;
                    expect(await cvxLocker.rewardTokens(0)).eq(cvxCrv.address);
                    await expect(cvxLocker.rewardTokens(1)).to.be.reverted;
                    expect(await cvxLocker.queuedRewards(cvxCrv.address)).eq(0);
                    expect(await cvxLocker.rewardDistributors(cvxCrv.address, cvxStakingProxy.address)).eq(true);
                    expect(await cvxLocker.lockedSupply()).eq(0);
                    expect(await cvxLocker.stakingToken()).eq(cvx.address);
                    expect(await cvxLocker.cvxCrv()).eq(cvxCrv.address);
                    expect(await cvxLocker.cvxcrvStaking()).eq(cvxCrvRewards.address);
                    expect(await cvxLocker.name()).eq(naming.vlCvxName);
                    expect(await cvxLocker.symbol()).eq(naming.vlCvxSymbol);
                    expect(await cvxLocker.owner()).eq(multisigs.daoMultisig);
                });
                it("Aura staking proxy has correct config", async () => {
                    const { cvxLocker, cvxCrv, cvxStakingProxy, cvx, crvDepositorWrapper } = phase2;
                    const { multisigs, addresses } = config;
                    expect(await cvxStakingProxy.crv()).eq(addresses.token);
                    expect(await cvxStakingProxy.cvx()).eq(cvx.address);
                    expect(await cvxStakingProxy.cvxCrv()).eq(cvxCrv.address);
                    expect(await cvxStakingProxy.keeper()).eq(!addresses.keeper ? ZERO_ADDRESS : addresses.keeper);
                    expect(await cvxStakingProxy.crvDepositorWrapper()).eq(crvDepositorWrapper.address);
                    expect(await cvxStakingProxy.outputBps()).eq(9950);
                    expect(await cvxStakingProxy.rewards()).eq(cvxLocker.address);
                    expect(await cvxStakingProxy.owner()).eq(multisigs.daoMultisig);
                    expect(await cvxStakingProxy.pendingOwner()).eq(ZERO_ADDRESS);
                });
                it("Chef has correct config", async () => {
                    const { cvx, chef } = phase2;
                    const { distroList } = config;
                    expect(await chef.cvx()).eq(cvx.address);
                    const totalBlocks = BN.from(7000).mul(365).mul(4);
                    const cvxPerBlock = distroList.lpIncentives.div(totalBlocks);
                    assertBNClosePercent(await chef.rewardPerBlock(), cvxPerBlock, "0.01");
                    expect(await chef.poolLength()).eq(1);
                    expect((await chef.poolInfo(0)).lpToken.toLowerCase()).eq(
                        "0x6641a8c1d33bd3dec8dd85e69c63cafb5bf36388",
                    );
                    expect(await chef.totalAllocPoint()).eq(1000);
                    const block = await latestBlock();
                    const expectedStart = BN.from(block.number).add(BN.from(6900).mul(7));
                    expect(await chef.startBlock()).gt(expectedStart);
                    expect(await chef.startBlock()).lt(expectedStart.add(700));

                    const expectedEnd = expectedStart.add(BN.from(7000).mul(365).mul(4));
                    expect(await chef.endBlock()).gt(expectedEnd.sub(10000));
                    expect(await chef.endBlock()).lt(expectedEnd.add(10000));
                });
                it("VestedEscrows have correct config", async () => {
                    const { vestedEscrows } = phase2;
                    expect(vestedEscrows.length).eq(5);

                    // [ 0 ] = 16 weeks
                    const escrow0 = vestedEscrows[0];
                    expect(await escrow0.rewardToken()).eq(phase2.cvx.address);
                    expect(await escrow0.admin()).eq(config.multisigs.vestingMultisig);
                    expect(await escrow0.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await escrow0.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await escrow0.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await escrow0.endTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(17)).sub(5400));
                    expect(await escrow0.endTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(17)).add(5400));
                    expect(await escrow0.totalTime()).eq(ONE_WEEK.mul(16));
                    expect(await escrow0.initialised()).eq(true);
                    expect(await escrow0.remaining("0xb64f3884ceed18594bd707122988e913fa26f4bf")).eq(
                        simpleToExactAmount(0.008, 24),
                    );
                    // [ 1 ] = 26 weeks
                    const escrow1 = vestedEscrows[1];
                    expect(await escrow1.rewardToken()).eq(phase2.cvx.address);
                    expect(await escrow1.admin()).eq(config.multisigs.vestingMultisig);
                    expect(await escrow1.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await escrow1.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await escrow1.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await escrow1.endTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(27)).sub(5400));
                    expect(await escrow1.endTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(27)).add(5400));
                    expect(await escrow1.totalTime()).eq(ONE_WEEK.mul(26));
                    expect(await escrow1.initialised()).eq(true);
                    expect(await escrow1.remaining(config.multisigs.vestingMultisig)).eq(
                        simpleToExactAmount(1.4515, 24),
                    );
                    // [ 2 ] = 104 weeks
                    const escrow2 = vestedEscrows[2];
                    expect(await escrow2.rewardToken()).eq(phase2.cvx.address);
                    expect(await escrow2.admin()).eq(config.multisigs.vestingMultisig);
                    expect(await escrow2.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await escrow2.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await escrow2.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await escrow2.endTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(105)).sub(5400));
                    expect(await escrow2.endTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(105)).add(5400));
                    expect(await escrow2.totalTime()).eq(ONE_WEEK.mul(104));
                    expect(await escrow2.initialised()).eq(true);
                    expect(await escrow2.remaining("0xB1f881f47baB744E7283851bC090bAA626df931d")).eq(
                        simpleToExactAmount(3.5, 24),
                    );
                    // [ 3 ] = 104 weeks, 2%
                    const escrow3 = vestedEscrows[3];
                    expect(await escrow3.rewardToken()).eq(phase2.cvx.address);
                    expect(await escrow3.admin()).eq(ZERO_ADDRESS);
                    expect(await escrow3.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await escrow3.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await escrow3.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await escrow3.endTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(105)).sub(5400));
                    expect(await escrow3.endTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(105)).add(5400));
                    expect(await escrow3.totalTime()).eq(ONE_WEEK.mul(104));
                    expect(await escrow3.initialised()).eq(true);
                    expect(await escrow3.remaining(config.addresses.treasury)).eq(simpleToExactAmount(2, 24));
                    // [ 4 ] = 208 weeks, 17.5%
                    const escrow4 = vestedEscrows[4];
                    expect(await escrow4.rewardToken()).eq(phase2.cvx.address);
                    expect(await escrow4.admin()).eq(ZERO_ADDRESS);
                    expect(await escrow4.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await escrow4.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await escrow4.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await escrow4.endTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(209)).sub(5400));
                    expect(await escrow4.endTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(209)).add(5400));
                    expect(await escrow4.totalTime()).eq(ONE_WEEK.mul(208));
                    expect(await escrow4.initialised()).eq(true);
                    expect(await escrow4.remaining(config.multisigs.treasuryMultisig)).eq(
                        simpleToExactAmount(17.5, 24),
                    );
                });
                it("Drops have correct config", async () => {
                    const { drops } = phase2;
                    const { multisigs } = config;
                    const [rootHashOne, rootHashTwo] = merkleDropRootHashes;

                    expect(drops.length).eq(2);

                    // [ 0 ] = 2.5m, 4 weeks
                    const drop = drops[0];
                    expect(await drop.dao()).eq(multisigs.treasuryMultisig);
                    expect(await drop.merkleRoot()).eq(rootHashOne);
                    expect(await drop.aura()).eq(phase2.cvx.address);
                    expect(await drop.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await drop.penaltyForwarder()).eq(phase2.penaltyForwarder.address);
                    expect(await drop.pendingPenalty()).eq(0);
                    expect(await drop.startTime()).gt(phase2Timestamp.add(ONE_WEEK).sub(5400));
                    expect(await drop.startTime()).lt(phase2Timestamp.add(ONE_WEEK).add(5400));
                    expect(await drop.expiryTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(5)).sub(5400));
                    expect(await drop.expiryTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(5)).add(5400));
                    expect(await phase2.cvx.balanceOf(drop.address)).eq(simpleToExactAmount(2.5, 24));
                    // [ 1 ] = 1m, 26 weeks
                    const drop1 = drops[1];
                    expect(await drop1.dao()).eq(multisigs.treasuryMultisig);
                    expect(await drop1.merkleRoot()).eq(rootHashTwo);
                    expect(await drop1.aura()).eq(phase2.cvx.address);
                    expect(await drop1.auraLocker()).eq(phase2.cvxLocker.address);
                    expect(await drop1.penaltyForwarder()).eq(phase2.penaltyForwarder.address);
                    expect(await drop1.pendingPenalty()).eq(0);
                    expect(await drop1.startTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(26)).sub(5400));
                    expect(await drop1.startTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(26)).add(5400));
                    expect(await drop1.expiryTime()).gt(phase2Timestamp.add(ONE_WEEK.mul(52)).sub(5400));
                    expect(await drop1.expiryTime()).lt(phase2Timestamp.add(ONE_WEEK.mul(52)).add(5400));
                    expect(await phase2.cvx.balanceOf(drop1.address)).eq(simpleToExactAmount(1, 24));
                });
                it("LbpBPT has correct config", async () => {
                    const { cvx, lbpBpt } = phase2;
                    // Token amounts
                    // Weights
                    // Swap = false
                    // Balance = treasuryDAO
                    const balancerVault = IBalancerVault__factory.connect(config.addresses.balancerVault, deployer);
                    const balances = await balancerVault.getPoolTokens(lbpBpt.poolId);
                    const pool = IBalancerPool__factory.connect(lbpBpt.address, deployer);
                    const weights = await pool.getNormalizedWeights();
                    if (balances.tokens[0].toLowerCase() == cvx.address.toLowerCase()) {
                        expect(balances.balances[0]).eq(simpleToExactAmount(2.2, 24));
                        expect(balances.balances[1]).eq(simpleToExactAmount(100));
                        console.log(weights[0].toString(), weights[1].toString());
                        assertBNClosePercent(weights[0], simpleToExactAmount(99, 16), "0.1");
                        assertBNClosePercent(weights[1], simpleToExactAmount(1, 16), "0.1");
                    } else {
                        expect(balances.balances[1]).eq(simpleToExactAmount(2.2, 24));
                        expect(balances.balances[0]).eq(simpleToExactAmount(100));
                        console.log(weights[0].toString(), weights[1].toString());
                        assertBNClosePercent(weights[1], simpleToExactAmount(99, 16), "0.1");
                        assertBNClosePercent(weights[0], simpleToExactAmount(1, 16), "0.1");
                    }
                    const swapEnabled = await pool.getSwapEnabled();
                    expect(swapEnabled).eq(false);

                    const poolERC20 = IERC20__factory.connect(lbpBpt.address, deployer);
                    expect(await poolERC20.balanceOf(config.multisigs.treasuryMultisig)).eq(
                        (await poolERC20.totalSupply()).sub(simpleToExactAmount(1, 6)),
                    );
                });
                it("balLiquidityProvider has correct config", async () => {
                    const { balLiquidityProvider, cvx } = phase2;
                    const { multisigs, addresses } = config;

                    expect(await balLiquidityProvider.startToken()).eq(cvx.address);
                    expect(await balLiquidityProvider.pairToken()).eq(addresses.weth);
                    expect(await balLiquidityProvider.minPairAmount()).eq(simpleToExactAmount(375));
                    expect(await balLiquidityProvider.dao()).eq(multisigs.treasuryMultisig);
                    expect(await balLiquidityProvider.bVault()).eq(addresses.balancerVault);
                    expect(await cvx.balanceOf(balLiquidityProvider.address)).eq(simpleToExactAmount(2.8, 24));
                });
                it("penaltyForwarder has correct config", async () => {
                    const { penaltyForwarder, extraRewardsDistributor, cvx } = phase2;

                    expect(await penaltyForwarder.distributor()).eq(extraRewardsDistributor.address);
                    expect(await penaltyForwarder.token()).eq(cvx.address);
                    expect(await penaltyForwarder.owner()).eq(config.multisigs.daoMultisig);
                    expect(await penaltyForwarder.distributionDelay()).eq(ONE_WEEK.mul(7).div(2));
                    assertBNClose(await penaltyForwarder.lastDistribution(), phase2Timestamp, 5400);
                });
                it("extraRewardsDistributor has correct config", async () => {
                    const { extraRewardsDistributor, cvxLocker } = phase2;
                    expect(await extraRewardsDistributor.auraLocker()).eq(cvxLocker.address);
                    expect(await extraRewardsDistributor.owner()).eq(config.multisigs.daoMultisig);
                });
            });
        });

        describe("POST-Phase 2", () => {
            let lbp: ILBP;
            let launchSigner: Account;
            let currentTime: BN;
            before(async () => {
                launchSigner = await impersonateAccount(deployerAddress);
                lbp = ILBP__factory.connect(phase2.lbpBpt.address, launchSigner.signer);
                currentTime = BN.from(
                    (await hre.ethers.provider.getBlock(await hre.ethers.provider.getBlockNumber())).timestamp,
                );
            });
            it("allows treasuryDAO to update weights gradually", async () => {
                const balHelper = new AssetHelpers(config.addresses.weth);
                const [, weights] = balHelper.sortTokens(
                    [phase2.cvx.address, config.addresses.weth],
                    [simpleToExactAmount(55, 16), simpleToExactAmount(45, 16)],
                );
                const tx = await lbp.updateWeightsGradually(
                    currentTime.add(5400),
                    currentTime.add(ONE_DAY.mul(3)),
                    weights as BN[],
                );
                await waitForTx(tx, debug);
            });
            it("allows treasuryDAO to set swaps", async () => {
                const tx = await lbp.setSwapEnabled(true);
                await waitForTx(tx, debug);
            });
        });

        describe("TEST-Phase 2", () => {
            let treasurySigner: Account;
            let daoSigner: Account;
            let balancerVault: IBalancerVault;
            before(async () => {
                treasurySigner = await impersonateAccount(config.multisigs.treasuryMultisig);
                daoSigner = await impersonateAccount(config.multisigs.daoMultisig);
                balancerVault = IBalancerVault__factory.connect(config.addresses.balancerVault, treasurySigner.signer);
            });

            it("doesn't allow dao to set more than 10k votes on gaugeController", async () => {
                const { booster } = phase2;
                const { addresses } = config;
                await expect(
                    booster
                        .connect(daoSigner.signer)
                        .voteGaugeWeight([addresses.gauges[0], addresses.gauges[1]], [5001, 5000]),
                ).to.be.revertedWith("Used too much power");
            });
            it("allows dao to vote on gauge weights", async () => {
                const { booster, voterProxy } = phase2;
                const { addresses } = config;
                await booster
                    .connect(daoSigner.signer)
                    .voteGaugeWeight([addresses.gauges[0], addresses.gauges[1]], [5000, 5000]);
                const gaugeController = MockVoting__factory.connect(addresses.gaugeController, deployer);
                expect((await gaugeController.vote_user_slopes(voterProxy.address, addresses.gauges[0])).power).eq(
                    5000,
                );
                expect(await gaugeController.vote_user_power(voterProxy.address)).eq(10000);
                expect(await gaugeController.last_user_vote(voterProxy.address, addresses.gauges[1])).gt(0);
                expect(await gaugeController.last_user_vote(voterProxy.address, addresses.gauges[2])).eq(0);
            });
            it("doesn't allow dao to set votes again so quickly on gaugeController", async () => {
                const { booster } = phase2;
                const { addresses } = config;
                await expect(
                    booster
                        .connect(daoSigner.signer)
                        .voteGaugeWeight([addresses.gauges[0], addresses.gauges[1]], [5001, 5000]),
                ).to.be.revertedWith("Cannot vote so often");
            });
            it("allows dao to setVotes for Snapshot", async () => {
                const msg = "message";
                const hash = hashMessage(msg);
                const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);

                const tx = await phase2.booster.connect(daoMultisig.signer).setVote(hash);
                await expect(tx).to.emit(phase2.voterProxy, "VoteSet").withArgs(hash, false);

                const isValid = await phase2.voterProxy.isValidSignature(hash, "0x00");
                expect(isValid).to.equal("0xffffffff");
            });
            it("doesn't allow pools to be added or rewards earmarked", async () => {
                const { poolManager, booster } = phase2;
                const { addresses } = config;

                await expect(poolManager["addPool(address)"](addresses.gauges[0])).to.be.revertedWith("!auth");

                await expect(booster.earmarkRewards(0)).to.be.reverted;
            });
            it("doesn't add feeInfo to Booster", async () => {
                const { booster } = phase2;
                const { addresses } = config;

                const balFee = await booster.feeTokens(addresses.token);
                expect(balFee.distro).eq(ZERO_ADDRESS);
                expect(balFee.rewards).eq(ZERO_ADDRESS);
                expect(balFee.active).eq(false);

                await expect(booster.earmarkFees(addresses.token)).to.be.revertedWith("Inactive distro");
            });

            const swapEthForAura = async (sender: Account, amount = simpleToExactAmount(100), limit = 0) => {
                const currentTime = BN.from(
                    (await hre.ethers.provider.getBlock(await hre.ethers.provider.getBlockNumber())).timestamp,
                );
                const tx = await balancerVault.connect(sender.signer).swap(
                    {
                        poolId: phase2.lbpBpt.poolId,
                        kind: SwapKind.GivenIn,
                        assetIn: config.addresses.weth,
                        assetOut: phase2.cvx.address,
                        amount: amount,
                        userData: "0x",
                    },
                    {
                        sender: sender.address,
                        fromInternalBalance: false,
                        recipient: sender.address,
                        toInternalBalance: false,
                    },
                    limit,
                    currentTime.add(60 * 15),
                );
                await waitForTx(tx, debug);
            };
            // T = 0 -> 5
            it("executes some swaps", async () => {
                const swapper = await impersonateAccount(testAccounts.swapper);
                await getEth(testAccounts.swapper);
                await getWeth(testAccounts.swapper, simpleToExactAmount(600));

                const weth = MockERC20__factory.connect(config.addresses.weth, swapper.signer);
                let tx = await weth.approve(balancerVault.address, simpleToExactAmount(600));
                await waitForTx(tx, debug);

                // t = 0
                await increaseTime(ONE_HOUR.mul(2));
                await swapEthForAura(swapper, simpleToExactAmount(20));

                await increaseTime(ONE_HOUR.mul(2));
                await swapEthForAura(swapper, simpleToExactAmount(20));

                await increaseTime(ONE_HOUR.mul(2));
                await swapEthForAura(swapper, simpleToExactAmount(20));

                await increaseTime(ONE_HOUR.mul(2));
                await swapEthForAura(swapper, simpleToExactAmount(20));

                await increaseTime(ONE_HOUR.mul(4));
                await swapEthForAura(swapper, simpleToExactAmount(20));

                await increaseTime(ONE_HOUR.mul(6));
                await swapEthForAura(swapper, simpleToExactAmount(50));

                await increaseTime(ONE_HOUR.mul(6));
                // t = 1
                await swapEthForAura(swapper, simpleToExactAmount(50));

                await increaseTime(ONE_HOUR.mul(12));
                await swapEthForAura(swapper, simpleToExactAmount(50));

                await increaseTime(ONE_HOUR.mul(12));
                // t = 2
                await swapEthForAura(swapper, simpleToExactAmount(50));

                await increaseTime(ONE_HOUR.mul(24));
                // t = 3
                await swapEthForAura(swapper, simpleToExactAmount(100));

                const launchSigner = await impersonateAccount(deployerAddress);
                const lbp = ILBP__factory.connect(phase2.lbpBpt.address, launchSigner.signer);
                const currentTime = BN.from(
                    (await hre.ethers.provider.getBlock(await hre.ethers.provider.getBlockNumber())).timestamp,
                );
                const balHelper = new AssetHelpers(config.addresses.weth);
                const [, weights] = balHelper.sortTokens(
                    [phase2.cvx.address, config.addresses.weth],
                    [simpleToExactAmount(25, 16), simpleToExactAmount(75, 16)],
                );
                tx = await lbp.updateWeightsGradually(
                    currentTime.add(900),
                    currentTime.add(ONE_DAY.mul(2)),
                    weights as BN[],
                );
                await waitForTx(tx, debug);

                await increaseTime(ONE_HOUR.mul(24));
                // t = 4
                await swapEthForAura(swapper, simpleToExactAmount(100));

                await increaseTime(ONE_HOUR.mul(24));
                // t = 5
                await swapEthForAura(swapper, simpleToExactAmount(100));
            });
            it("allows AURA holders to stake in vlAURA", async () => {
                const { cvxLocker, cvx } = phase2;

                const swapper = await impersonateAccount(testAccounts.swapper);

                await cvx.connect(swapper.signer).approve(cvxLocker.address, simpleToExactAmount(100000));
                await cvxLocker.connect(swapper.signer).lock(testAccounts.swapper, simpleToExactAmount(100000));

                const lock = await cvxLocker.lockedBalances(testAccounts.swapper);
                expect(lock.total).eq(simpleToExactAmount(100000));
                expect(lock.unlockable).eq(0);
                expect(lock.locked).eq(simpleToExactAmount(100000));
                expect(lock.lockData[0].amount).eq(simpleToExactAmount(100000));
                const balance = await cvxLocker.balanceOf(testAccounts.swapper);
                expect(balance).eq(0);
            });
        });
    });

    describe("Phase 3", () => {
        describe("PRE-Phase 3", () => {
            let treasurySigner: Account;
            let balancerVault: IBalancerVault;
            let weth: ERC20;
            let aura: ERC20;
            let bpt: ERC20;
            before(async () => {
                treasurySigner = await impersonateAccount(config.multisigs.treasuryMultisig);
                balancerVault = IBalancerVault__factory.connect(config.addresses.balancerVault, treasurySigner.signer);
                weth = MockERC20__factory.connect(config.addresses.weth, treasurySigner.signer);
                aura = phase2.cvx.connect(treasurySigner.signer);
                bpt = MockERC20__factory.connect(phase2.lbpBpt.address, treasurySigner.signer);
            });
            it("allows treasuryDAO to withdraw LBP units", async () => {
                const wethBalBefore = await weth.balanceOf(treasurySigner.address);
                const auraBalBefore = await aura.balanceOf(treasurySigner.address);
                const lpBalBefore = await bpt.balanceOf(treasurySigner.address);

                const balances = await balancerVault.getPoolTokens(phase2.lbpBpt.poolId);

                const tx = await balancerVault.exitPool(
                    phase2.lbpBpt.poolId,
                    treasurySigner.address,
                    treasurySigner.address,
                    {
                        assets: balances.tokens,
                        minAmountsOut: balances.balances.map(b => b.mul(9).div(10)),
                        userData: hre.ethers.utils.defaultAbiCoder.encode(
                            ["uint256", "uint256"],
                            [WeightedPoolExitKind.EXACT_BPT_IN_FOR_TOKENS_OUT, lpBalBefore],
                        ),
                        toInternalBalance: false,
                    },
                );
                await waitForTx(tx, debug);

                const wethBalAfter = await weth.balanceOf(treasurySigner.address);
                const auraBalAfter = await aura.balanceOf(treasurySigner.address);
                const lpBalAfter = await bpt.balanceOf(treasurySigner.address);

                expect(wethBalAfter).gte(wethBalBefore.add(simpleToExactAmount(500)));
                expect(auraBalAfter).gte(auraBalBefore.add(simpleToExactAmount(200000)));
                expect(lpBalAfter).eq(0);
            });
            it("treasuryDAO sends weth to liq provider", async () => {
                const wethBal = await weth.balanceOf(treasurySigner.address);
                const tx = await weth.transfer(phase2.balLiquidityProvider.address, wethBal);
                await waitForTx(tx, debug);
            });
            it("treasuryDAO sends aura to liq provider", async () => {
                const tx = await phase2.balLiquidityProvider
                    .connect(treasurySigner.signer)
                    .rescueToken(aura.address, simpleToExactAmount(1, 24));
                await waitForTx(tx, debug);
            });
        });
        describe("DEPLOY-Phase 3", () => {
            before(async () => {
                // PHASE 3
                phase3 = await deployPhase3(hre, deployer, phase2, config.multisigs, config.addresses, debug);
                await increaseTime(ONE_HOUR.mul(48));
            });
            describe("verifying config", () => {
                it("creates the 8020 pool successfully", async () => {
                    const { pool8020Bpt, cvx, balLiquidityProvider } = phase3;

                    const treasurySigner = await impersonateAccount(config.multisigs.treasuryMultisig);
                    const balancerVault = IBalancerVault__factory.connect(
                        config.addresses.balancerVault,
                        treasurySigner.signer,
                    );

                    // Token amounts (non on balLiquidityProvider)
                    expect(await cvx.balanceOf(balLiquidityProvider.address)).eq(0);
                    expect(
                        await IERC20__factory.connect(config.addresses.weth, deployer).balanceOf(
                            balLiquidityProvider.address,
                        ),
                    ).eq(0);

                    const pool = IBalancerPool__factory.connect(pool8020Bpt.address, deployer);
                    expect(await pool.getOwner()).eq(config.addresses.balancerPoolOwner);

                    // Weights
                    const poolTokens = await balancerVault.getPoolTokens(pool8020Bpt.poolId);
                    const weights = await pool.getNormalizedWeights();
                    if (poolTokens.tokens[0].toLowerCase() == cvx.address.toLowerCase()) {
                        expect(poolTokens.tokens[1]).eq(config.addresses.weth);
                        assertBNClosePercent(weights[0], simpleToExactAmount(80, 16), "0.0001");
                        assertBNClosePercent(weights[1], simpleToExactAmount(20, 16), "0.0001");
                    } else {
                        expect(poolTokens.tokens[1]).eq(cvx.address);
                        assertBNClosePercent(weights[0], simpleToExactAmount(20, 16), "0.0001");
                        assertBNClosePercent(weights[1], simpleToExactAmount(80, 16), "0.0001");
                    }

                    // Balance = treasuryDAO
                    const poolERC20 = IERC20__factory.connect(pool8020Bpt.address, deployer);
                    expect(await poolERC20.balanceOf(config.multisigs.treasuryMultisig)).eq(
                        (await poolERC20.totalSupply()).sub(simpleToExactAmount(1, 6)),
                    );
                });
            });
        });
        describe("POST-Phase 3", () => {
            it("allows initial auraBAL rewards to be initialised", async () => {
                const tx = await phase3.initialCvxCrvStaking.initialiseRewards();
                await waitForTx(tx, debug);
            });
        });
        describe("TEST-Phase 3", () => {
            let alice: Account;
            let crv: ERC20;
            let crvBpt: ERC20;
            before(async () => {
                alice = await impersonateAccount(testAccounts.alice);
                crv = MockERC20__factory.connect(config.addresses.token, alice.signer);
                crvBpt = MockERC20__factory.connect(config.addresses.tokenBpt, alice.signer);

                await getCrv(alice.address, simpleToExactAmount(500));
                await getCrvBpt(alice.address, simpleToExactAmount(500));
            });
            describe("minting cvxCrv etc", () => {
                it("allows users to wrap crvBpt to cvxCrv", async () => {
                    let tx = await crvBpt.approve(phase3.crvDepositor.address, simpleToExactAmount(700));
                    await waitForTx(tx, debug);

                    tx = await phase3.crvDepositor
                        .connect(alice.signer)
                        ["deposit(uint256,bool)"](simpleToExactAmount(500), true);
                    await waitForTx(tx, debug);

                    const balance = await phase3.cvxCrv.balanceOf(alice.address);
                    expect(balance).eq(simpleToExactAmount(500));
                });
                it("allows users to wrap crv via the crvDepositorWrapper", async () => {
                    let tx = await crv.approve(phase3.crvDepositorWrapper.address, simpleToExactAmount(500));
                    await waitForTx(tx, debug);

                    const minOut = await phase3.crvDepositorWrapper.getMinOut(simpleToExactAmount(500), 9900);
                    expect(minOut).gt(simpleToExactAmount(190));

                    tx = await phase3.crvDepositorWrapper
                        .connect(alice.signer)
                        .deposit(simpleToExactAmount(500), minOut, true, ZERO_ADDRESS);
                    await waitForTx(tx, debug);

                    const balance = await phase3.cvxCrv.balanceOf(alice.address);
                    expect(balance).gt(simpleToExactAmount(690));

                    expect(await crv.balanceOf(alice.address)).eq(0);
                    expect(await crvBpt.balanceOf(alice.address)).eq(0);
                });
                it("allows deposits to cvxCrv staking", async () => {
                    await getCrvBpt(alice.address, simpleToExactAmount(200));

                    const rewardsBalBefore = await phase3.initialCvxCrvStaking.balanceOf(alice.address);
                    expect(rewardsBalBefore).eq(0);
                    const cvxCrvSupply = await phase3.cvxCrv.totalSupply();

                    const tx = await phase3.crvDepositor
                        .connect(alice.signer)
                        .depositFor(alice.address, simpleToExactAmount(200), true, phase3.initialCvxCrvStaking.address);
                    await waitForTx(tx, debug);

                    const rewardsBalAfter = await phase3.initialCvxCrvStaking.balanceOf(alice.address);
                    expect(rewardsBalAfter).eq(simpleToExactAmount(200));
                    expect(await crvBpt.balanceOf(alice.address)).eq(0);

                    const cvxCrvSupplyAfter = await phase3.cvxCrv.totalSupply();
                    expect(cvxCrvSupplyAfter.sub(cvxCrvSupply)).eq(simpleToExactAmount(200));
                });
                it("allows users to claim and lock from cvxCrv staking", async () => {
                    const { initialCvxCrvStaking, cvxLocker } = phase3;
                    await increaseTime(ONE_HOUR.mul(4));
                    const earnedBefore = await initialCvxCrvStaking.earned(alice.address);
                    expect(earnedBefore).gt(1000000000);
                    const lockerBalBefore = await cvxLocker.lockedBalances(alice.address);

                    await initialCvxCrvStaking.connect(alice.signer).getReward(true);

                    const earnedAfter = await initialCvxCrvStaking.earned(alice.address);
                    assertBNClose(earnedAfter, BN.from(0), 1000);
                    const lockerBalafter = await cvxLocker.lockedBalances(alice.address);

                    assertBNClosePercent(lockerBalafter.total.sub(lockerBalBefore.total), earnedBefore, "0.05");
                });
                it("allows users to claim directly from cvxCrv staking with penalty", async () => {
                    const { initialCvxCrvStaking, cvx } = phase3;
                    await increaseTime(ONE_HOUR.mul(4));
                    const earnedBefore = await initialCvxCrvStaking.earned(alice.address);
                    expect(earnedBefore).gt(1000000000);
                    const rawBalBefore = await cvx.balanceOf(alice.address);
                    const penaltyBefore = await initialCvxCrvStaking.pendingPenalty();

                    await initialCvxCrvStaking.connect(alice.signer).getReward(false);

                    const earnedAfter = await initialCvxCrvStaking.earned(alice.address);
                    assertBNClose(earnedAfter, BN.from(0), 1000);
                    const rawBalAfter = await cvx.balanceOf(alice.address);
                    assertBNClosePercent(rawBalAfter.sub(rawBalBefore), earnedBefore.div(10).mul(7), "0.01");
                    const penaltyAfter = await initialCvxCrvStaking.pendingPenalty();
                    expect(penaltyAfter.sub(penaltyBefore)).eq(rawBalAfter.sub(rawBalBefore).div(7).mul(3));
                });
                it("allows anyone to forward the penalty", async () => {
                    const { initialCvxCrvStaking, cvx } = phase3;
                    const pendingPenaltyBefore = await initialCvxCrvStaking.pendingPenalty();
                    const rawBalBefore = await cvx.balanceOf(initialCvxCrvStaking.address);
                    expect(pendingPenaltyBefore).gt(0);

                    await initialCvxCrvStaking.forwardPenalty();

                    const pendingPenaltyAfter = await initialCvxCrvStaking.pendingPenalty();
                    expect(pendingPenaltyAfter).eq(0);

                    const rawBalAfter = await cvx.balanceOf(initialCvxCrvStaking.address);
                    expect(rawBalBefore.sub(rawBalAfter)).eq(pendingPenaltyBefore);
                });
            });
            describe("merkle drops", () => {
                let treasurySigner: Account;

                const eoaAddress = testAccounts.eoa;

                const droppers = {
                    whale: {
                        address: "0xaac0aa431c237c2c0b5f041c8e59b3f1a43ac78f",
                        allocation: "33506849383911890434692",
                        proof: [
                            "0x64ba60d122129529b5b4918bff20bb06ed9cfa0b36a2e98eb7fa76cfe843d6eb",
                            "0xa814cc528b740fb4747f73159c7795cee2f1d0066a4f7149b571d59ba7f8a09c",
                            "0x57bd385d61d91d48fce9ae5cce25d267d3413676f9536a51e2c387b095e5ad2e",
                            "0xb47bccb93ef22497862d10874187f6f5cf8eec577c85b2fa34774e2a212d9fab",
                            "0xebd0d4775d2b87bd5cf332f2814aeebb26f7d25d1c3ed57bb8d2b0d12f027822",
                            "0x7ca8e1ebc3b9f55d5964f2b0c4bceacb5668ec312172ae36a48366c274adf1a7",
                            "0xc27964bb54804faec9516aeabfbd6668771f46f73aaf79f75398c1cb1ab8649a",
                            "0xc03cf7cab523ad13bd48a07eab870f5aaa96c563d5627b927f9ee0f61b970b79",
                            "0x35e72f290ff5743bebce699e286c7a075d608a5e1035e0164e4ff3d8c14344af",
                            "0x7326586626d8d3f3b78bb792a9f5f7788acbe04eb83f992ac8b9462b30d2f3aa",
                            "0x14737b2e4f69768d546edf1c090e03113a5f4dad097fd7e618519c56405a4dc0",
                            "0xc3d849f7a9528b1c7a94b37fa96daddd882b85442a136fd1a2a89b9785392b03",
                            "0x885f3b9b64e16f0a6490c275896092c04f932fd1a484ba7049c7ae632e301a23",
                        ],
                    },
                    random: {
                        address: "0xd44e9b676e74ae45c0a39150be771eb189bb2337",
                        allocation: "54902353274534171135",
                        proof: [
                            "0xce88fdda44cdc9df7e2b476be97e5640732ccd0d24b37b9e2ac1b465b3161c5d",
                            "0x58eaea0e6ec476540887a70366974bb9e5c132a6273191ba664466b8beab6230",
                            "0xc2683136951485c250e3b296d39eb2c4ce4ec067c5c7262ce47b94d014afda84",
                            "0x9d1b255473d3eca0df590734759f86f859b43281f715a959cbafad0a6b804582",
                            "0x6783bd160a894f76487a4b5624c692118e2388f72cea6c81771b18db4ae2747d",
                            "0xe51c6386356f4956fd2e50202f100bc8af66ec7fd495967b913004372fa1969d",
                            "0x222411a4a8dc940a433e901644bb90e12c557545a630be921a0dc1dda2240306",
                            "0x5d7de7658f74a7d2b0f1e93b5205527e9e437d044dac26f531d436a14f2bfd45",
                            "0x50aad8ab44109bc8c9f157ecf6fcd3721a9c74c6960b9917f26fac6e07344336",
                            "0xb36c26ded6ea094c2756427a8553f7a0eabd45d576dafd50a3b08d65ba8f67c0",
                            "0xc956d31b7d2625ccd552ccd900e6184cfa4629d168eb8ac3f4e0411bd08cee43",
                            "0x66f5cde9ed8c57a0eec9fad4191975a11199fc07a748d3d95b06285b78a6b425",
                        ],
                    },
                };

                before(async () => {
                    treasurySigner = await impersonateAccount(config.multisigs.treasuryMultisig);
                    if ((await phase3.drops[0].merkleRoot()) == ZERO_KEY) {
                        await phase3.drops[0].connect(treasurySigner.signer).setRoot(merkleDropRootHashes[0]);
                    }
                });
                it("doesn't allow just anyone to claim a merkle drop", async () => {
                    const { drops } = phase3;

                    const eoa = await impersonateAccount(eoaAddress);
                    await expect(
                        drops[0].connect(eoa.signer).claim(droppers.whale.proof, droppers.whale.allocation, true),
                    ).to.be.revertedWith("invalid proof");
                });
                it("requires a valid proof", async () => {
                    const { drops } = phase3;

                    const dropper = await impersonateAccount(droppers.whale.address);
                    const emptyProof = Array.from({ length: 12 }).map(() => ZERO_KEY);
                    await expect(
                        drops[0].connect(dropper.signer).claim(emptyProof, droppers.whale.allocation, true),
                    ).to.be.revertedWith("invalid proof");
                });
                it("allows users to claim merkle drops", async () => {
                    const { drops, cvxLocker } = phase3;

                    {
                        const balBefore = (await cvxLocker.lockedBalances(droppers.whale.address)).locked;
                        const dropper = await impersonateAccount(droppers.whale.address);
                        await drops[0]
                            .connect(dropper.signer)
                            .claim(droppers.whale.proof, droppers.whale.allocation, true);

                        const balAfter = (await cvxLocker.lockedBalances(droppers.whale.address)).locked;
                        expect(balAfter.sub(balBefore)).eq(droppers.whale.allocation);
                    }
                    {
                        const balBefore = (await cvxLocker.lockedBalances(droppers.random.address)).locked;
                        const dropper = await impersonateAccount(droppers.random.address);
                        await drops[0]
                            .connect(dropper.signer)
                            .claim(droppers.random.proof, droppers.random.allocation, true);

                        const balAfter = (await cvxLocker.lockedBalances(droppers.random.address)).locked;
                        expect(balAfter.sub(balBefore)).eq(droppers.random.allocation);
                    }
                });
            });
            describe("vesting", () => {
                it("allows users to claim vesting", async () => {
                    const { vestedEscrows, cvx } = phase3;
                    const escrow = vestedEscrows[2];

                    const user = "0xB1f881f47baB744E7283851bC090bAA626df931d";
                    const userAcc = await impersonateAccount(user);

                    const balBefore = await cvx.balanceOf(user);
                    const availableBefore = await escrow.available(user);
                    const remainingBefore = await escrow.remaining(user);

                    expect(availableBefore).gt(0);
                    assertBNClosePercent(remainingBefore, simpleToExactAmount(3.5, 24), "0.11");

                    await escrow.connect(userAcc.signer).claim(false);

                    const balAfter = await cvx.balanceOf(user);
                    const availableAfter = await escrow.available(user);
                    // const remainingAfter = await escrow.remaining(user);

                    const credited = balAfter.sub(balBefore);
                    expect(credited).gt(0);
                    // expect(remainingBefore.sub(remainingAfter)).eq(credited);
                    assertBNClose(availableAfter, BN.from(0), 10000000);
                });
            });
            describe("chef", () => {
                let treasurySigner: Account;
                let cvxCrvBptToken: ERC20;

                before(async () => {
                    treasurySigner = await impersonateAccount(config.multisigs.treasuryMultisig);
                    cvxCrvBptToken = ERC20__factory.connect(
                        "0x6641a8c1d33bd3dec8dd85e69c63cafb5bf36388",
                        treasurySigner.signer,
                    );
                    // TODO - remove once on mainnet
                    await advanceBlock(BN.from(7000).mul(7));
                    expect(await hre.ethers.provider.getBlockNumber()).gt(await phase3.chef.startBlock());
                });
                it("allows users to deposit BPT for chef rewards", async () => {
                    const balBefore = await cvxCrvBptToken.balanceOf(treasurySigner.address);
                    expect(balBefore).gt(0);

                    await cvxCrvBptToken.approve(phase3.chef.address, balBefore);
                    await phase3.chef.connect(treasurySigner.signer).deposit(0, balBefore);

                    const balAfter = await cvxCrvBptToken.balanceOf(treasurySigner.address);
                    expect(balAfter).eq(0);
                    const chefBal = await cvxCrvBptToken.balanceOf(phase3.chef.address);
                    expect(chefBal).eq(balBefore);

                    const userBalance = await phase3.chef.userInfo(0, treasurySigner.address);
                    expect(userBalance.amount).eq(balBefore);
                });
                it("allows users to claim said rewards", async () => {
                    await increaseTime(ONE_HOUR);

                    const balBefore = await phase3.cvx.balanceOf(treasurySigner.address);
                    await phase3.chef.connect(treasurySigner.signer).claim(0, treasurySigner.address);
                    const balAfter = await phase3.cvx.balanceOf(treasurySigner.address);

                    expect(balAfter.sub(balBefore)).gt(0);

                    const userBalance = await phase3.chef.userInfo(0, treasurySigner.address);
                    expect(userBalance.rewardDebt).eq(balAfter.sub(balBefore));
                });
            });
        });
    });

    describe("Phase 4", () => {
        describe("PRE-Phase 4", () => {
            it("only allows daoMultisig to set protect pool to false", async () => {
                await expect(phase3.poolManager.connect(deployer).setProtectPool(false)).to.be.revertedWith("!auth");

                const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                const tx = await phase3.poolManager.connect(daoMultisig.signer).setProtectPool(false);
                await waitForTx(tx, debug);
            });
            it("only allows daoMultisig to set Fee info (bbaUSD)", async () => {
                await expect(
                    phase3.boosterOwner
                        .connect(deployer)
                        .setFeeInfo(config.addresses.feeToken, config.addresses.feeDistribution),
                ).to.be.revertedWith("!owner");

                await expect(
                    phase3.booster
                        .connect(deployer)
                        .setFeeInfo(config.addresses.feeToken, config.addresses.feeDistribution),
                ).to.be.revertedWith("!auth");

                const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                const tx = await phase3.boosterOwner
                    .connect(daoMultisig.signer)
                    .setFeeInfo(config.addresses.feeToken, config.addresses.feeDistribution);
                await waitForTx(tx, debug);

                const feeInfo = await phase3.booster.feeTokens(config.addresses.feeToken);
                expect(feeInfo.distro).eq(config.addresses.feeDistribution);
                expect(feeInfo.rewards).eq(await phase3.cvxCrvRewards.extraRewards(0));
                expect(feeInfo.rewards).not.eq(phase3.cvxCrvRewards.address);
                expect(feeInfo.active).eq(true);
            });
            it("only allows daoMultisig to set Fee info (native token)", async () => {
                const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                const tx = await phase3.boosterOwner
                    .connect(daoMultisig.signer)
                    .setFeeInfo(config.addresses.token, config.addresses.feeDistribution);
                await waitForTx(tx, debug);

                const feeInfo = await phase3.booster.feeTokens(config.addresses.token);
                expect(feeInfo.distro).eq(config.addresses.feeDistribution);
                expect(feeInfo.rewards).eq(phase3.cvxCrvRewards.address);
                expect(feeInfo.active).eq(true);
            });
        });
        describe("DEPLOY-Phase 4", () => {
            before(async () => {
                // PHASE 4
                phase4 = await deployPhase4(hre, deployer, phase3, config.addresses, debug);
            });
            describe("verifying config", () => {
                it("has correct config for feeCollector", async () => {
                    const { feeCollector, booster, voterProxy } = phase4;
                    const { addresses } = config;

                    expect(await feeCollector.booster()).eq(booster.address);
                    expect(await feeCollector.voterProxy()).eq(voterProxy.address);
                    expect(await feeCollector.feeDistro()).eq(addresses.feeDistribution);
                });
                it("has correct config for claimZap", async () => {
                    const { claimZap, cvx, cvxCrv, crvDepositorWrapper, cvxLocker, cvxCrvRewards } = phase4;
                    const { addresses } = config;

                    expect(await claimZap.crv()).eq(addresses.token);
                    expect(await claimZap.cvx()).eq(cvx.address);
                    expect(await claimZap.cvxCrv()).eq(cvxCrv.address);
                    expect(await claimZap.crvDepositWrapper()).eq(crvDepositorWrapper.address);
                    expect(await claimZap.cvxCrvRewards()).eq(cvxCrvRewards.address);
                    expect(await claimZap.locker()).eq(cvxLocker.address);
                    expect(await claimZap.owner()).eq(deployerAddress);
                });
                it("adds the pools", async () => {
                    const { booster, voterProxy, factories } = phase4;
                    const { addresses } = config;

                    expect(await booster.poolLength()).gt(0);

                    const pool0 = await booster.poolInfo(0);
                    expect(pool0.gauge).eq(addresses.gauges[0]);
                    expect(pool0.stash).not.eq(ZERO_ADDRESS);

                    await booster.earmarkRewards(0);

                    const rewardContract = BaseRewardPool4626__factory.connect(pool0.crvRewards, deployer);

                    await expect(rewardContract.extraRewards(0)).to.be.reverted;

                    const stash = ExtraRewardStashV3__factory.connect(pool0.stash, deployer);
                    expect(await stash.pid()).eq(0);
                    expect(await stash.operator()).eq(booster.address);
                    expect(await stash.staker()).eq(voterProxy.address);
                    expect(await stash.gauge()).eq(pool0.gauge);
                    expect(await stash.rewardFactory()).eq(factories.rewardFactory.address);
                    expect(await stash.hasRedirected()).eq(true);
                    expect(await stash.hasCurveRewards()).eq(false);
                    await expect(stash.tokenList(0)).to.be.reverted;
                });
                // check for a gauge with a stash and make sure it has been added
                it("extraRewardsStash has correct config", async () => {
                    // Pool id 6 (0xcD4722B7c24C29e0413BDCd9e51404B4539D14aE) has a reward token of LDO
                    // Let's check it's being processed correctly and is claimable by users
                    const { booster, factories, voterProxy } = phase4;
                    const poolInfo = await booster.poolInfo(4);
                    expect(poolInfo.gauge).eq("0xcD4722B7c24C29e0413BDCd9e51404B4539D14aE");
                    expect(poolInfo.stash).not.eq(ZERO_ADDRESS);

                    await booster.earmarkRewards(4);

                    const rewardContract = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, deployer);
                    const virtualRewardPool = await rewardContract.extraRewards(0);
                    expect(virtualRewardPool).not.eq(ZERO_ADDRESS);

                    const stash = ExtraRewardStashV3__factory.connect(poolInfo.stash, deployer);
                    expect(await stash.pid()).eq(4);
                    expect(await stash.operator()).eq(booster.address);
                    expect(await stash.staker()).eq(voterProxy.address);
                    expect(await stash.gauge()).eq("0xcD4722B7c24C29e0413BDCd9e51404B4539D14aE");
                    expect(await stash.rewardFactory()).eq(factories.rewardFactory.address);
                    expect(await stash.hasRedirected()).eq(true);
                    expect(await stash.hasCurveRewards()).eq(true);
                    const rToken = await stash.tokenList(0);
                    expect(rToken).eq("0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32");
                    const tokenInfo = await stash.tokenInfo(rToken);
                    expect(tokenInfo.token).eq(rToken);
                    expect(tokenInfo.rewardAddress).eq(virtualRewardPool);
                });
            });
        });
        describe("TEST-Phase 4", () => {
            let stakerAddress: string;
            let staker: Account;

            before(async () => {
                stakerAddress = testAccounts.staker;
                staker = await impersonateAccount(stakerAddress);
            });

            describe("stash tests", () => {
                it("extraRewardsStash actually processes reward tokens", async () => {
                    // Pool id 6 (0xcD4722B7c24C29e0413BDCd9e51404B4539D14aE) has a reward token of LDO
                    // Let's check it's being processed correctly and is claimable by users
                    const { booster } = phase4;
                    const poolInfo = await booster.poolInfo(4);
                    expect(poolInfo.gauge).eq("0xcD4722B7c24C29e0413BDCd9e51404B4539D14aE");
                    expect(poolInfo.stash).not.eq(ZERO_ADDRESS);
                    const baseRewardPool = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, staker.signer);
                    const extraRewardPool = VirtualBalanceRewardPool__factory.connect(
                        await baseRewardPool.extraRewards(0),
                        staker.signer,
                    );
                    await getEth("0x3c0aea3576b0d70e581ff613248a74d56cde0853");

                    const tokenWhaleSigner = await impersonateAccount("0x3c0aea3576b0d70e581ff613248a74d56cde0853");
                    const tkn = MockERC20__factory.connect(poolInfo.lptoken, tokenWhaleSigner.signer);
                    let tx = await tkn.transfer(stakerAddress, simpleToExactAmount(100));
                    await waitForTx(tx, debug);

                    // 0 - Deposit into the pool
                    tx = await tkn.connect(staker.signer).approve(baseRewardPool.address, simpleToExactAmount(100));
                    await waitForTx(tx, debug);
                    tx = await baseRewardPool.deposit(simpleToExactAmount(100), stakerAddress);
                    await waitForTx(tx, debug);
                    expect(await baseRewardPool.balanceOf(stakerAddress)).gt(0);
                    await increaseTime(ONE_HOUR);

                    // 1 - Earmarking rewards should transfer more rewards to the pool
                    const ldoDepositor = await impersonateAccount(config.addresses.stEthGaugeLdoDepositor);
                    const gauge = MockCurveGauge__factory.connect(poolInfo.gauge, ldoDepositor.signer);
                    const rewardToken = MockERC20__factory.connect(config.addresses.ldo, staker.signer);
                    await getLdo(ldoDepositor.address, simpleToExactAmount(10));
                    tx = await rewardToken
                        .connect(ldoDepositor.signer)
                        .approve(poolInfo.gauge, ethers.constants.MaxUint256);
                    await waitForTx(tx, debug);
                    tx = await gauge
                        .connect(ldoDepositor.signer)
                        .deposit_reward_token(rewardToken.address, simpleToExactAmount(10));
                    await waitForTx(tx, debug);

                    const rewardBalBefore = await rewardToken.balanceOf(extraRewardPool.address);
                    tx = await booster.earmarkRewards(4);
                    await waitForTx(tx, debug);
                    const rewardBalAfter = await rewardToken.balanceOf(extraRewardPool.address);
                    expect(rewardBalAfter.sub(rewardBalBefore)).gt(0);

                    // 2 - Claiming should allow users to claim the rewards
                    const userBalBefore = await rewardToken.balanceOf(stakerAddress);
                    tx = await baseRewardPool["getReward()"]();
                    await waitForTx(tx, debug);
                    const userBalAfter = await rewardToken.balanceOf(stakerAddress);
                    expect(userBalAfter.sub(userBalBefore)).gt(0);
                });
                it("allows NEW rewards to be added to extraRewardsStash and claimed", async () => {
                    const { booster } = phase4;
                    const poolInfo = await booster.poolInfo(4);
                    const baseRewardPool = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, staker.signer);
                    const authorizer = await impersonateAccount("0x8f42adbba1b16eaae3bb5754915e0d06059add75");
                    const gauge = MockCurveGauge__factory.connect(poolInfo.gauge, authorizer.signer);

                    // 1. Add reward token to gauge through impersonation
                    const mockToken = await new MockERC20__factory(authorizer.signer).deploy(
                        "MK1",
                        "MK1",
                        18,
                        authorizer.address,
                        100,
                    );
                    await gauge.add_reward(mockToken.address, authorizer.address);
                    await mockToken.approve(poolInfo.gauge, ethers.constants.MaxUint256);
                    await gauge.deposit_reward_token(mockToken.address, simpleToExactAmount(10));

                    // 2. Stash checks for new reward tokens
                    const rewardsBefore = await baseRewardPool.extraRewardsLength();
                    await booster.earmarkRewards(4);
                    const rewardsAfter = await baseRewardPool.extraRewardsLength();
                    expect(rewardsAfter).eq(rewardsBefore.add(1));

                    // 3 - Claiming should allow users to claim the rewards
                    const userBalBefore = await mockToken.balanceOf(stakerAddress);
                    await baseRewardPool["getReward()"]();
                    const userBalAfter = await mockToken.balanceOf(stakerAddress);
                    expect(userBalAfter.sub(userBalBefore)).gt(0);
                });
            });

            describe("booster & deposits", () => {
                it("allow deposit into pool via Booster", async () => {
                    await getLpToken(stakerAddress, simpleToExactAmount(10));

                    const poolInfo = await phase4.booster.poolInfo(0);
                    expect(poolInfo.lptoken.toLowerCase()).eq(config.addresses.staBAL3.toLowerCase());

                    const lptoken = ERC20__factory.connect(poolInfo.lptoken, deployer);
                    const lptokenBalance = await lptoken.balanceOf(stakerAddress);
                    const depositToken = ERC20__factory.connect(poolInfo.token, deployer);
                    const depositTokenBalanceBefore = await depositToken.balanceOf(stakerAddress);

                    expect(lptokenBalance).gt(0);

                    const stake = false;
                    await lptoken.connect(staker.signer).approve(phase4.booster.address, ethers.constants.MaxUint256);
                    await phase4.booster.connect(staker.signer).deposit(0, lptokenBalance, stake);

                    const depositTokenBalanceAfter = await depositToken.balanceOf(stakerAddress);
                    expect(depositTokenBalanceAfter.sub(depositTokenBalanceBefore)).eq(lptokenBalance);
                });
                it("allows auraBPT deposits directly into the reward pool", async () => {
                    const poolInfo = await phase4.booster.poolInfo(0);

                    const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, staker.signer);
                    const depositToken = ERC20__factory.connect(poolInfo.token, staker.signer);
                    const balance = await depositToken.balanceOf(stakerAddress);

                    const rewardBalanceBefore = await rewards.balanceOf(stakerAddress);
                    await depositToken.approve(rewards.address, balance);
                    await rewards.stake(balance);
                    const rewardBalanceAfter = await rewards.balanceOf(stakerAddress);
                    expect(rewardBalanceAfter.sub(rewardBalanceBefore)).eq(balance);
                });
                it("allows BPT deposits directly into the reward pool", async () => {
                    await getLpToken(stakerAddress, simpleToExactAmount(10));
                    const poolInfo = await phase4.booster.poolInfo(0);

                    const lpToken = ERC20__factory.connect(poolInfo.lptoken, staker.signer);
                    const baseRewardPool = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, staker.signer);

                    const lpTokenBalance = await lpToken.balanceOf(stakerAddress);

                    const rewardBalanceBefore = await baseRewardPool.balanceOf(stakerAddress);

                    await lpToken.approve(baseRewardPool.address, lpTokenBalance);
                    await baseRewardPool.deposit(lpTokenBalance, stakerAddress);
                    const rewardBalanceAfter = await baseRewardPool.balanceOf(stakerAddress);

                    expect(rewardBalanceAfter.sub(rewardBalanceBefore)).eq(lpTokenBalance);
                });
                it("allows withdrawals directly from the pool 4626", async () => {
                    const amount = simpleToExactAmount(1);
                    const poolInfo = await phase4.booster.poolInfo(0);

                    const rewards = BaseRewardPool4626__factory.connect(poolInfo.crvRewards, staker.signer);
                    const lptoken = ERC20__factory.connect(poolInfo.lptoken, staker.signer);
                    const balanceBefore = await lptoken.balanceOf(stakerAddress);

                    await rewards["withdraw(uint256,address,address)"](amount, stakerAddress, stakerAddress);

                    const balanceAfter = await lptoken.balanceOf(stakerAddress);
                    expect(balanceAfter.sub(balanceBefore)).eq(amount);
                });
                it("allows withdrawals directly from the pool normal", async () => {
                    const amount = simpleToExactAmount(1);
                    const poolInfo = await phase4.booster.poolInfo(0);

                    const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, staker.signer);
                    const depositToken = ERC20__factory.connect(poolInfo.token, staker.signer);
                    const balanceBefore = await depositToken.balanceOf(stakerAddress);

                    await rewards.withdraw(amount, false);

                    const balanceAfter = await depositToken.balanceOf(stakerAddress);
                    expect(balanceAfter.sub(balanceBefore)).eq(amount);
                });
                it("allows earmarking of fees ($BAL)", async () => {
                    await getCrv(stakerAddress, simpleToExactAmount(10));
                    const feeInfo = await phase3.booster.feeTokens(config.addresses.token);
                    const crv = MockERC20__factory.connect(config.addresses.token, deployer);
                    await crv.connect(staker.signer).transfer(feeInfo.distro, simpleToExactAmount(10));

                    const feeToken = ERC20__factory.connect(config.addresses.token, deployer);
                    const balanceBefore = await feeToken.balanceOf(feeInfo.rewards);
                    await increaseTime(ONE_WEEK);

                    await phase4.booster.earmarkFees(config.addresses.token);
                    const balanceAfter = await feeToken.balanceOf(feeInfo.rewards);
                    expect(balanceAfter).gt(balanceBefore);
                });
                it("allows earmarking of fees ($bb-a-USD)", async () => {
                    const feeInfo = await phase3.booster.feeTokens(config.addresses.feeToken);

                    const tokenWhaleSigner = await impersonateAccount(config.addresses.balancerVault);
                    const bbausd = MockERC20__factory.connect(config.addresses.feeToken, tokenWhaleSigner.signer);
                    const tx = await bbausd.transfer(feeInfo.distro, simpleToExactAmount(100));
                    await waitForTx(tx, debug);

                    const feeToken = ERC20__factory.connect(config.addresses.feeToken, deployer);
                    const balanceBefore = await feeToken.balanceOf(feeInfo.rewards);
                    await increaseTime(ONE_WEEK);

                    await phase4.booster.earmarkFees(config.addresses.feeToken);
                    const balanceAfter = await feeToken.balanceOf(feeInfo.rewards);
                    expect(balanceAfter).gt(balanceBefore);
                });
                it("allows earmarking of rewards", async () => {
                    const poolInfo = await phase4.booster.poolInfo(0);
                    const crvRewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, deployer);
                    const crv = MockERC20__factory.connect(config.addresses.token, deployer);
                    const balanceBefore = await crv.balanceOf(crvRewards.address);

                    await increaseTime(ONE_HOUR);
                    await phase4.booster.earmarkRewards(0);

                    const balanceAfter = await crv.balanceOf(crvRewards.address);
                    expect(balanceAfter).gt(balanceBefore);
                });
                it("pays out a premium to the caller", async () => {
                    const crv = ERC20__factory.connect(config.addresses.token, deployer);
                    const balanceBefore = await crv.balanceOf(stakerAddress);
                    await increaseTime(ONE_HOUR);
                    await phase4.booster.connect(staker.signer).earmarkRewards(0);
                    const balanceAfter = await crv.balanceOf(stakerAddress);
                    expect(balanceAfter).gt(balanceBefore);
                });
                it("allows users to earn $BAl and $AURA", async () => {
                    const crv = ERC20__factory.connect(config.addresses.token, deployer);
                    const poolInfo = await phase4.booster.poolInfo(0);
                    const rewards = BaseRewardPool__factory.connect(poolInfo.crvRewards, deployer);
                    const cvxBalanceBefore = await phase4.cvx.balanceOf(stakerAddress);
                    const crvBalanceBefore = await crv.balanceOf(stakerAddress);
                    const earned = await rewards.earned(stakerAddress);
                    await rewards["getReward(address,bool)"](stakerAddress, true);
                    const cvxBalanceAfter = await phase4.cvx.balanceOf(stakerAddress);
                    const crvBalanceAfter = await crv.balanceOf(stakerAddress);

                    const crvBalance = crvBalanceAfter.sub(crvBalanceBefore);
                    const cvxBalance = cvxBalanceAfter.sub(cvxBalanceBefore);

                    expect(crvBalance).gte(earned);
                    expect(cvxBalance).gt(0);
                });
                it("allows conversion of rewards via AuraStakingProxy", async () => {
                    const crv = MockERC20__factory.connect(config.addresses.token, deployer);
                    const crvBalance = await crv.balanceOf(phase4.cvxStakingProxy.address);
                    expect(crvBalance).gt(0);

                    const keeper = await impersonateAccount(config.addresses.keeper);

                    const callerCvxCrvBalanceBefore = await phase4.cvxCrv.balanceOf(keeper.address);
                    const cvxLockerCvxCrvBalanceBefore = await phase4.cvxCrv.balanceOf(phase4.cvxLocker.address);

                    await phase4.cvxStakingProxy.connect(keeper.signer)["distribute()"]();
                    const callerCvxCrvBalanceAfter = await phase4.cvxCrv.balanceOf(keeper.address);
                    const cvxLockerCvxCrvBalanceAfter = await phase4.cvxCrv.balanceOf(phase4.cvxLocker.address);

                    expect(callerCvxCrvBalanceAfter).gt(callerCvxCrvBalanceBefore);
                    expect(cvxLockerCvxCrvBalanceAfter).gt(cvxLockerCvxCrvBalanceBefore);
                });
            });
            describe("admin etc", () => {
                it("does not allow a duplicate pool to be added", async () => {
                    const poolInfo = await phase4.booster.poolInfo(0);
                    const tx = phase4.poolManager["addPool(address)"](poolInfo.gauge);
                    await expect(tx).to.be.revertedWith("already registered gauge");
                });
                it("allows a pool to be shut down", async () => {
                    const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);

                    const pid = 5;
                    const poolInfoBefore = await phase4.booster.poolInfo(pid);
                    expect(poolInfoBefore.shutdown).eq(false);

                    await phase4.poolManager.connect(daoMultisig.signer).shutdownPool(pid);

                    const poolInfoAfter = await phase4.booster.poolInfo(pid);
                    expect(poolInfoAfter.shutdown).eq(true);
                });
                it("allows the fee rates to be set", async () => {
                    const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);

                    const lockIncentive = await phase4.booster.lockIncentive();
                    const stakerIncentive = await phase4.booster.stakerIncentive();
                    const earmarkIncentive = await phase4.booster.earmarkIncentive();
                    const platformFee = await phase4.booster.platformFee();

                    await phase4.booster
                        .connect(daoMultisig.signer)
                        .setFees(
                            lockIncentive.add(1),
                            stakerIncentive.add(1),
                            earmarkIncentive.add(1),
                            platformFee.add(1),
                        );

                    const lockIncentiveAfter = await phase4.booster.lockIncentive();
                    const stakerIncentiveAfter = await phase4.booster.stakerIncentive();
                    const earmarkIncentiveAfter = await phase4.booster.earmarkIncentive();
                    const platformFeeAfter = await phase4.booster.platformFee();

                    expect(lockIncentiveAfter).eq(lockIncentive.add(1));
                    expect(stakerIncentiveAfter).eq(stakerIncentive.add(1));
                    expect(earmarkIncentiveAfter).eq(earmarkIncentive.add(1));
                    expect(platformFeeAfter).eq(platformFee.add(1));

                    // reset fees
                    await phase4.booster
                        .connect(daoMultisig.signer)
                        .setFees(lockIncentive, stakerIncentive, earmarkIncentive, platformFee);
                });
                it("does not allow the system to be shut down", async () => {
                    const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                    const tx = phase4.boosterOwner.connect(daoMultisig.signer).shutdownSystem();
                    await expect(tx).to.be.revertedWith("!poolMgrShutdown");
                });
                it("does not allow a fee info to be added that has a gauge", async () => {
                    const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                    const poolInfo = await phase4.booster.poolInfo(0);

                    const maliciousFeeDistro = await deployContract<MockFeeDistributor>(
                        hre,
                        new MockFeeDistributor__factory(deployer),
                        "MockFeeDistro",
                        [[], []],
                        {},
                        debug,
                    );

                    const tx = phase4.boosterOwner
                        .connect(daoMultisig.signer)
                        .setFeeInfo(poolInfo.gauge, maliciousFeeDistro.address);

                    await expect(tx).to.be.revertedWith("!token");
                });
                it("allows a fee to be disabled", async () => {
                    const daoMultisig = await impersonateAccount(config.multisigs.daoMultisig);
                    await phase4.boosterOwner.connect(daoMultisig.signer).updateFeeInfo(config.addresses.token, false);
                    const feeInfo = await phase4.booster.feeTokens(config.addresses.token);
                    expect(feeInfo.active).eq(false);

                    // reset feeInfo
                    await phase4.boosterOwner.connect(daoMultisig.signer).updateFeeInfo(config.addresses.token, true);
                    const feeInfoNow = await phase4.booster.feeTokens(config.addresses.token);
                    expect(feeInfoNow.active).eq(true);
                });
            });
            describe("boosterOwner", () => {
                let daoSigner: Account;
                before(async () => {
                    daoSigner = await impersonateAccount(config.multisigs.daoMultisig);
                });
                it("does not allow boosterOwner to revert control", async () => {
                    await expect(phase4.boosterOwner.connect(daoSigner.signer).setBoosterOwner()).to.be.revertedWith(
                        "ownership sealed",
                    );
                });
                it("allows boosterOwner owner to be changed", async () => {
                    const newOwner = await impersonateAccount(config.multisigs.vestingMultisig);
                    let owner = await phase4.boosterOwner.owner();
                    expect(owner).eq(daoSigner.address);

                    await phase4.boosterOwner.connect(daoSigner.signer).transferOwnership(newOwner.address);
                    owner = await phase4.boosterOwner.owner();
                    expect(owner).eq(daoSigner.address);
                    let pendingOwner = await phase4.boosterOwner.pendingowner();
                    expect(pendingOwner).eq(newOwner.address);

                    await expect(phase4.boosterOwner.connect(daoSigner.signer).acceptOwnership()).to.be.revertedWith(
                        "!pendingowner",
                    );

                    await phase4.boosterOwner.connect(newOwner.signer).acceptOwnership();
                    owner = await phase4.boosterOwner.owner();
                    expect(owner).eq(newOwner.address);
                    pendingOwner = await phase4.boosterOwner.pendingowner();
                    expect(pendingOwner).eq(ZERO_ADDRESS);

                    await phase4.boosterOwner.connect(newOwner.signer).transferOwnership(daoSigner.address);
                    await phase4.boosterOwner.connect(daoSigner.signer).acceptOwnership();
                });
                it("allows boosterOwner to call all fns on booster", async () => {
                    const { booster, boosterOwner } = phase4;

                    await boosterOwner.connect(daoSigner.signer).setFeeManager(config.multisigs.treasuryMultisig);
                    expect(await booster.feeManager()).eq(config.multisigs.treasuryMultisig);
                    await boosterOwner.connect(daoSigner.signer).setFeeManager(daoSigner.address);

                    await boosterOwner.connect(daoSigner.signer).setFactories(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS);
                    expect(await booster.stashFactory()).eq(ZERO_ADDRESS);
                    expect(await booster.tokenFactory()).not.eq(ZERO_ADDRESS);
                    expect(await booster.rewardFactory()).not.eq(ZERO_ADDRESS);

                    await boosterOwner.connect(daoSigner.signer).setArbitrator(ZERO_ADDRESS);
                    expect(await booster.rewardArbitrator()).eq(ZERO_ADDRESS);

                    await boosterOwner.connect(daoSigner.signer).setVoteDelegate(ZERO_ADDRESS);
                    expect(await booster.voteDelegate()).eq(ZERO_ADDRESS);
                    await boosterOwner.connect(daoSigner.signer).setVoteDelegate(daoSigner.address);

                    await boosterOwner.connect(daoSigner.signer).updateFeeInfo(config.addresses.token, false);
                    expect((await booster.feeTokens(config.addresses.token)).active).eq(false);
                });
            });
            describe("crv depositor", () => {
                it("allows BPT deposits", async () => {
                    const crvBpt = ERC20__factory.connect(config.addresses.tokenBpt, deployer);
                    const rewardBalanceBefore = await phase4.cvxCrvRewards.balanceOf(stakerAddress);

                    await getCrvBpt(stakerAddress, simpleToExactAmount(10));

                    const crvBptBalance = await crvBpt.balanceOf(stakerAddress);
                    await crvBpt.connect(staker.signer).approve(phase4.crvDepositor.address, crvBptBalance);
                    await phase4.crvDepositor
                        .connect(staker.signer)
                        ["deposit(uint256,bool,address)"](crvBptBalance, false, phase4.cvxCrvRewards.address);

                    const lockIncentive = await phase4.crvDepositor.lockIncentive();
                    const FEE_DENOMINATOR = await phase4.crvDepositor.FEE_DENOMINATOR();
                    const incentive = crvBptBalance.mul(lockIncentive).div(FEE_DENOMINATOR);

                    const rewardBalanceAfter = await phase4.cvxCrvRewards.balanceOf(stakerAddress);
                    expect(rewardBalanceAfter.sub(rewardBalanceBefore)).eq(crvBptBalance.sub(incentive));
                });
                it("pays out the incentives to the caller", async () => {
                    const incentiveCrv = await phase4.crvDepositor.incentiveCrv();
                    expect(incentiveCrv).gt(0);
                    const balanceBefore = await phase4.cvxCrv.balanceOf(stakerAddress);
                    await phase4.crvDepositor.connect(staker.signer).lockCurve();
                    const balanceAfter = await phase4.cvxCrv.balanceOf(stakerAddress);
                    expect(balanceAfter.sub(balanceBefore)).eq(incentiveCrv);
                });
            });
            describe("aura locker", () => {
                it("allows users to lock aura", async () => {
                    const cvxBalance = await phase4.cvx.balanceOf(stakerAddress);
                    const balancesBefore = await phase4.cvxLocker.balances(stakerAddress);
                    await phase4.cvx.connect(staker.signer).approve(phase4.cvxLocker.address, cvxBalance);
                    await phase4.cvxLocker.connect(staker.signer).lock(stakerAddress, cvxBalance);
                    const balancesAfter = await phase4.cvxLocker.balances(stakerAddress);
                    expect(balancesAfter.locked.sub(balancesBefore.locked)).eq(cvxBalance);
                });
                it("allows users to delegate voting power", async () => {
                    const delegateTo = "0x7F101fE45e6649A6fB8F3F8B43ed03D353f2B90c";
                    await phase4.cvxLocker.connect(staker.signer).delegate(delegateTo);
                    const delegated = await phase4.cvxLocker.delegates(stakerAddress);
                    expect(delegated).eq(delegateTo);
                });
                it("allows users to re-delegate", async () => {
                    await phase4.cvxLocker.connect(staker.signer).delegate(stakerAddress);
                    const delegated = await phase4.cvxLocker.delegates(stakerAddress);
                    expect(delegated).eq(stakerAddress);
                });
                it("has votes after checkpoint", async () => {
                    const votesBefore = await phase4.cvxLocker.getVotes(stakerAddress);
                    const cvxBalances = await phase4.cvxLocker.balances(stakerAddress);
                    await increaseTime(ONE_WEEK);
                    const votesAfter = await phase4.cvxLocker.getVotes(stakerAddress);
                    expect(votesAfter.sub(votesBefore)).eq(cvxBalances.locked);
                });
                it("allows users to claim rewards", async () => {
                    const cvxCrvBalanceBefore = await phase4.cvxCrv.balanceOf(stakerAddress);
                    await getCrv(phase4.booster.address, simpleToExactAmount(1));
                    await phase4.booster.earmarkRewards(0);

                    const keeper = await impersonateAccount(config.addresses.keeper);
                    await phase4.cvxStakingProxy.connect(keeper.signer)["distribute()"]();

                    await increaseTime(ONE_HOUR);
                    const rewards = await phase4.cvxLocker.claimableRewards(stakerAddress);
                    expect(rewards[0].amount).gt(0);
                    await phase4.cvxLocker.connect(staker.signer)["getReward(address)"](stakerAddress);
                    const cvxCrvBalanceAfter = await phase4.cvxCrv.balanceOf(stakerAddress);
                    const cvxCrvBalance = cvxCrvBalanceAfter.sub(cvxCrvBalanceBefore);
                    assertBNClosePercent(cvxCrvBalance, rewards[0].amount, "0.0001");
                });
            });
        });
    });
    describe("Phase X", () => {
        let stakerAddress: string;
        let staker: Account;

        before(async () => {
            stakerAddress = testAccounts.staker;
            staker = await impersonateAccount(stakerAddress);
        });

        // Start time t = 4.5 weeks
        // End  time  t = 5.5 weeks
        describe("1 month later", () => {
            it("allows any penalty to be forwarded to aura lockers via ExtraRewardDistributor", async () => {
                const { extraRewardsDistributor, penaltyForwarder, cvx } = phase4;

                // Check that a penalty has been accrued
                const penaltyBal = await cvx.balanceOf(penaltyForwarder.address);
                expect(penaltyBal).gt(0);
                const distributorBalBefore = await cvx.balanceOf(extraRewardsDistributor.address);

                // Forward the penalty to rewardsDistributor
                await penaltyForwarder.forward();

                // Check the reward has been added
                expect(await cvx.balanceOf(penaltyForwarder.address)).eq(0);
                const distributorBalAfter = await cvx.balanceOf(extraRewardsDistributor.address);
                expect(distributorBalAfter.sub(distributorBalBefore)).eq(penaltyBal);
                expect(await extraRewardsDistributor.rewardEpochsCount(cvx.address)).eq(1);

                // Check the reward is claimable
                expect(await extraRewardsDistributor.claimableRewards(stakerAddress, cvx.address)).eq(0);
                await increaseTime(ONE_WEEK);
                await phase4.cvxLocker.checkpointEpoch();

                // Claim it
                const balBefore = await cvx.balanceOf(stakerAddress);
                expect(await extraRewardsDistributor.claimableRewards(stakerAddress, cvx.address)).gt(0);
                await extraRewardsDistributor
                    .connect(staker.signer)
                    ["getReward(address,address)"](stakerAddress, cvx.address);
                const balAfter = await cvx.balanceOf(stakerAddress);
                expect(balAfter).gt(balBefore);

                // Check its not claimable again
                expect(await extraRewardsDistributor.claimableRewards(stakerAddress, cvx.address)).eq(0);
            });
        });
        // Start time t = 5.5 weeks
        describe("3 months later", () => {
            // alice
            // alice lock time = 1.5
            // alice unlock > 18 weeks
            // end = 18.5
            it("allows users to unlock from auraLocker", async () => {
                const { cvxLocker } = phase4;
                const alice = await impersonateAccount(testAccounts.alice);

                await expect(cvxLocker.connect(alice.signer).processExpiredLocks(true)).to.be.revertedWith(
                    "no exp locks",
                );

                await increaseTime(ONE_WEEK.mul(13));

                await expect(cvxLocker.kickExpiredLocks(alice.address)).to.be.revertedWith("no exp locks");
                await cvxLocker.connect(alice.signer).processExpiredLocks(false);
            });

            // time = 18.5
            // Staker lock on 3.5 weeks
            // Staker relock > 19 weeks
            // Staker unlock > 20 weeks
            // end time t = 20.5
            it("allows users to relock a week before finish", async () => {
                const { cvxLocker } = phase4;
                const lockedBalanceBefore = await cvxLocker.lockedBalances(stakerAddress);

                expect(lockedBalanceBefore.lockData.length).eq(1);
                let unlockTime = BN.from(lockedBalanceBefore.lockData[0].unlockTime);
                let currentTime = await getTimestamp();
                // unlock > 20 weeks
                expect(unlockTime.sub(currentTime)).gt(ONE_WEEK);
                // unlock < 20.5 weeks
                expect(unlockTime.sub(currentTime)).lt(ONE_WEEK.mul(2));

                const userBalanceBefore = await cvxLocker.balances(stakerAddress);
                expect(userBalanceBefore.nextUnlockIndex).eq(0);

                // increase to 19.5 weeks
                await increaseTime(ONE_WEEK);

                await expect(cvxLocker.connect(staker.signer).processExpiredLocks(false)).to.be.revertedWith(
                    "no exp locks",
                );
                await cvxLocker.connect(staker.signer).processExpiredLocks(true);

                const lockedBalanceAfter = await cvxLocker.lockedBalances(stakerAddress);
                expect(lockedBalanceAfter.lockData.length).eq(1);
                unlockTime = BN.from(lockedBalanceAfter.lockData[0].unlockTime);
                currentTime = await getTimestamp();
                expect(unlockTime.sub(currentTime)).gt(ONE_WEEK.mul(16));
                expect(unlockTime.sub(currentTime)).lt(ONE_WEEK.mul(17));

                const userBalanceAfter = await cvxLocker.balances(stakerAddress);
                expect(userBalanceAfter.nextUnlockIndex).eq(1);

                const votingPowerAfter = await cvxLocker.getVotes(stakerAddress);

                // increase to 20.5 weeks
                await increaseTime(ONE_WEEK);

                const votingPowerEnd = await cvxLocker.getVotes(stakerAddress);
                expect(votingPowerEnd).eq(votingPowerAfter);

                await expect(cvxLocker.connect(staker.signer).processExpiredLocks(true)).to.be.revertedWith(
                    "no exp locks",
                );
            });

            // time = 20.5
            // swapperAddress
            // swapper lock time = 0.5
            // swapper unlock > 17 weeks
            // swapper kick  > 20 weeks
            it("allows users to be kicked for a fee from auraLocker", async () => {
                const { cvxLocker } = phase4;
                const swapper = await impersonateAccount(testAccounts.swapper);

                await increaseTime(ONE_WEEK);
                await cvxLocker.kickExpiredLocks(swapper.address);
            });
        });
    });
});
