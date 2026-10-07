import { describe, expect, it } from 'vitest';
import { centsToDecimal, formatUSD, parseCents } from './money';

describe('money', () => {
  it('parses user input', () => {
    expect(parseCents('12')).toBe(1200);
    expect(parseCents('12.5')).toBe(1250);
    expect(parseCents('$1,234.56')).toBe(123456);
    expect(parseCents('-3.20')).toBe(-320);
    expect(parseCents('.99')).toBe(99);
    expect(parseCents('12.')).toBe(1200);
    expect(parseCents('1.234')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('')).toBeNull();
  });

  it('formats', () => {
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(centsToDecimal(0)).toBe('0.00');
    expect(formatUSD(123456)).toBe('$1,234.56');
    expect(formatUSD(-500)).toBe('-$5.00');
  });
});
