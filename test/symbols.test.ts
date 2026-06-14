import { describe, expect, it } from 'vitest';
import { SymbolMapper } from '../src/symbols';

describe('SymbolMapper', () => {
  const m = SymbolMapper.fromDefault();

  it('resolves gold and oil aliases', () => {
    expect(m.resolve('OANDA:XAUUSD')?.pairName).toBe('XAU/USD');
    expect(m.resolve('GOLD')?.pairName).toBe('XAU/USD');
    expect(m.resolve('TVC:USOIL')?.pairName).toBe('CL/USD');
    expect(m.resolve('WTI')?.pairName).toBe('CL/USD');
    expect(m.resolve('UKOIL')?.pairName).toBe('BRENT/USD');
  });

  it('resolves crypto and fx (incl. USDT folding)', () => {
    expect(m.resolve('BTCUSD')?.pairName).toBe('BTC/USD');
    expect(m.resolve('BINANCE:BTCUSDT')?.pairName).toBe('BTC/USD');
    expect(m.resolve('FX:EURUSD')?.pairName).toBe('EUR/USD');
    expect(m.resolve('OANDA:USDJPY')?.pairName).toBe('USD/JPY');
  });

  it('flips orientation when needed (CADUSD -> USD/CAD)', () => {
    expect(m.resolve('CADUSD')?.pairName).toBe('USD/CAD');
  });

  it('handles non-USD-quoted indices', () => {
    expect(m.resolve('GER40')?.pairName).toBe('DAX/EUR');
    expect(m.resolve('UK100')?.pairName).toBe('FTSE/GBP');
  });

  it('rejects unmapped tickers', () => {
    expect(m.resolve('TVC:DXY')).toBeNull();
    expect(m.resolve('SOMEGARBAGE')).toBeNull();
  });

  it('builds from SDK pairs (WTI display -> CL canonical) with pairIds', () => {
    const sdk = SymbolMapper.fromSdkPairs([
      { pairId: 0, pairFrom: 'BTC', pairTo: 'USD' },
      { pairId: 7, pairFrom: 'WTI', pairTo: 'USD' },
      { pairId: 5, pairFrom: 'XAU', pairTo: 'USD' },
    ]);
    expect(sdk.resolve('BTCUSD')?.pairId).toBe('0');
    expect(sdk.resolve('USOIL')?.pairName).toBe('CL/USD');
    expect(sdk.resolve('USOIL')?.pairId).toBe('7');
  });
});
