import { BigNumberish, Signer } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import fetch from "node-fetch";
import { ExtSystemConfig, Phase2Deployed } from "scripts/deploySystem";
import { Account, IERC20__factory, MockERC20__factory } from "../types";
import { simpleToExactAmount } from "./math";

// impersonates a specific account
export const impersonate = async (addr: string, fund = true): Promise<Signer> => {
    // Dynamic import hardhat module to avoid importing while hardhat config is being defined.
    // The error this avoids is:
    // Error HH9: Error while loading Hardhat's configuration.
    // You probably tried to import the "hardhat" module from your config or a file imported from it.
    // This is not possible, as Hardhat can't be initialized while its config is being defined.
    const { network, ethers } = await import("hardhat");
    await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [addr],
    });
    if (fund) {
        // Give the account 10 Ether
        await network.provider.request({
            method: "hardhat_setBalance",
            params: [addr, "0x8AC7230489E8000000"],
        });
    }
    return ethers.provider.getSigner(addr);
};

export const impersonateAccount = async (address: string, fund = true): Promise<Account> => {
    const signer = await impersonate(address, fund);
    return {
        signer,
        address,
    };
};

export async function impersonateAndTransfer(tokenAddress: string, from: string, to: string, amount: BigNumberish) {
    const tokenWhaleSigner = await impersonateAccount(from);
    const token = MockERC20__factory.connect(tokenAddress, tokenWhaleSigner.signer);
    await token.transfer(to, amount);
}

async function getEth(config: ExtSystemConfig, recipient: string) {
    const ethWhale = await impersonate(config.weth);
    await ethWhale.sendTransaction({
        to: recipient,
        value: simpleToExactAmount(1),
    });
}

export async function getBal(config: ExtSystemConfig, to: string, amount: BigNumberish) {
    await getEth(config, config.balancerVault);
    const tokenWhaleSigner = await impersonateAccount(config.balancerVault);
    const crv = IERC20__factory.connect(config.token, tokenWhaleSigner.signer);
    await crv.transfer(to, amount);
}

export async function getAuraBal(phase2: Phase2Deployed, config: ExtSystemConfig, to: string, amount: BigNumberish) {
    const acc = await impersonateAccount(config.balancerVault, true);
    const auraBal = IERC20__factory.connect(phase2.cvxCrv.address, acc.signer);
    await auraBal.transfer(to, amount);
}

export async function getAura(phase2: Phase2Deployed, config: ExtSystemConfig, to: string, amount: BigNumberish) {
    const acc = await impersonateAccount(config.balancerVault, true);
    const auraBal = IERC20__factory.connect(phase2.cvx.address, acc.signer);
    await auraBal.transfer(to, amount);
}

export const getCrv = getBal;
export const getCvx = getAura;

export async function forkWithTenderly(hre: HardhatRuntimeEnvironment, startBlock: number) {
    console.log("Forking with tenderly");
    const TENDERLY_ACCESS_KEY = process.env.TENDERLY_ACCESS_KEY;
    const TENDERLY_USER = process.env.TENDERLY_USER;
    const TENDERLY_PROJECT = process.env.TENDERLY_PROJECT;

    const TENDERLY_FORK_API = `https://api.tenderly.co/api/v1/account/${TENDERLY_USER}/project/${TENDERLY_PROJECT}/fork`;

    console.log("Fork: requesting API");
    const res = await fetch(TENDERLY_FORK_API, {
        method: "POST",
        body: JSON.stringify({
            network_id: "42161",
            block_number: startBlock,
        }),
        headers: {
            "X-Access-Key": TENDERLY_ACCESS_KEY,
            "Content-Type": "application/json",
        },
    });
    const json = await res.json();
    const forkId = json.simulation_fork.id;
    console.log(`Fork ID: ${forkId}`);
    const forkRPC = `https://rpc.tenderly.co/fork/${forkId}`;
    const provider = new hre.ethers.providers.JsonRpcProvider(forkRPC);
    hre.ethers.provider = provider;
}
