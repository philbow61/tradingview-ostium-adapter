/**
 * Load config.yaml + env secrets into typed config.
 * Secrets (delegate key, shared secrets) come from env; the yaml references env-var NAMES.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export interface SizingConfig {
  defaultMode: 'fixed_notional' | 'percent_of_equity' | 'risk_percent';
  defaultValue: number;
  maxPositionNotional: number;
  allowPayloadOverride: boolean;
}

export interface RiskConfig {
  maxOpenPositions: number;
  requireSlForRiskMode: boolean;
}

export interface StrategyConfig {
  strategyId: string;
  enabled: boolean;
  mode: 'dry_run' | 'live';
  secret: string;
  defaultLeverage: number;
  maxLeverage: number;
  slippagePct: number;
  sizing: SizingConfig;
  allowedPairs: string[];
  risk: RiskConfig;
}

export interface GlobalConfig {
  network: 'testnet' | 'mainnet';
  killSwitch: boolean;
  tvAllowedIps: string[];
  enforceIpAllowlist: boolean;
  maxLagSecHardCap: number;
  minCollateralUsdc: number;
}

export interface AppConfig {
  global: GlobalConfig;
  strategies: Record<string, StrategyConfig>;
}

function env(name: string): string {
  return process.env[name] ?? '';
}

export function loadConfig(path: string): AppConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) ?? {};
  const g = raw.global ?? {};
  const global: GlobalConfig = {
    network: g.network === 'mainnet' ? 'mainnet' : 'testnet',
    killSwitch: Boolean(g.kill_switch ?? false),
    tvAllowedIps: g.tv_allowed_ips ?? [],
    enforceIpAllowlist: Boolean(g.enforce_ip_allowlist ?? false),
    maxLagSecHardCap: Number(g.max_lag_sec_hard_cap ?? 120),
    minCollateralUsdc: Number(g.min_collateral_usdc ?? 5),
  };

  const strategies: Record<string, StrategyConfig> = {};
  for (const [sid, s] of Object.entries<Record<string, any>>(raw.strategies ?? {})) {
    const sizing = s.sizing ?? {};
    const risk = s.risk ?? {};
    strategies[sid] = {
      strategyId: sid,
      enabled: Boolean(s.enabled ?? true),
      mode: s.mode === 'live' ? 'live' : 'dry_run',
      secret: env(s.secret_env ?? ''),
      defaultLeverage: Number(s.default_leverage ?? 10),
      maxLeverage: Number(s.max_leverage ?? 50),
      slippagePct: Number(s.slippage_pct ?? 1),
      sizing: {
        defaultMode: sizing.default_mode ?? 'fixed_notional',
        defaultValue: Number(sizing.default_value ?? 100),
        maxPositionNotional: Number(sizing.max_position_notional ?? 2000),
        allowPayloadOverride: Boolean(sizing.allow_payload_override ?? true),
      },
      allowedPairs: s.allowed_pairs ?? [],
      risk: {
        maxOpenPositions: Number(risk.max_open_positions ?? 1),
        requireSlForRiskMode: Boolean(risk.require_sl_for_risk_mode ?? true),
      },
    };
  }

  return { global, strategies };
}

export function pairAllowed(strat: StrategyConfig, pairName: string): boolean {
  return strat.allowedPairs.length === 0 || strat.allowedPairs.includes(pairName);
}
