import { Signer } from "ethers";
import { SidechainPhase1Deployed, SidechainPhase2Deployed } from "scripts/deploySidechain";

export interface SidechainNaming {
    auraOftName: string;
    auraOftSymbol: string;
    auraBalOftName: string;
    auraBalOftSymbol: string;
    tokenFactoryNamePostfix: string;
}

export interface ExtSidechainConfig {
    token: string;
    minter: string;
    canonicalChainId: number;
    lzEndpoint: string;
    create2Factory: string;
    gauge?: string;
    gauges?: string[];
}

export interface SidechainMultisigConfig {
    daoMultisig: string;
    pauseGuardian: string;
}

export interface SidechainBridging {
    l1Receiver: string;
    l2Sender: string;
    nativeBridge: string;
}

export interface SidechainConfig {
    chainId: number;
    whales: { [key: string]: string };
    multisigs: SidechainMultisigConfig;
    naming: SidechainNaming;
    extConfig: ExtSidechainConfig;
    bridging: SidechainBridging;
    getSidechain?: (s: Signer) => SidechainPhase1Deployed & SidechainPhase2Deployed;
}
