import { describe, expect, it } from 'vitest';
import { CYCLE, DriveCycle } from '../src/core/sim/drive';

describe('simulator drive cycle', () => {
  const d = new DriveCycle(0, () => 0);
  it('goes through the whole trip', () => {
    expect(d.at(2)).toMatchObject({ phase: 'Key on, engine cold', running: false, rpm: 0, speed: 0, gear: 0 });
    expect(d.at(2).clt).toBeLessThan(30);
    const cold = d.at(20);
    expect(cold.phase).toBe('Cold start');
    expect(cold.rpm).toBeGreaterThan(1000);
    expect(d.at(70).phase).toBe('Warming up');
    const city = Array.from({ length: 120 }, (_, i) => d.at(80 + i));
    expect(Math.max(...city.map((s) => s.gear))).toBeGreaterThanOrEqual(3);
    expect(city.some((s) => s.speed === 0 && s.running)).toBe(true); // traffic light
    const top = d.at(292);
    expect(top.speed).toBeGreaterThan(225);
    expect(top.gear).toBe(5);
    expect(top.rpm).toBeLessThanOrEqual(6500);
    const idle = d.at(350);
    expect(idle.phase).toBe('Warm idle');
    expect(idle.rpm).toBeGreaterThan(650);
    expect(idle.rpm).toBeLessThan(800);
    expect(idle.clt).toBeGreaterThan(90);
    expect(d.at(380)).toMatchObject({ phase: 'Engine off', running: false, rpm: 0 });
  });
  it('repeats', () => {
    let now = 0;
    const c = new DriveCycle(0, () => now);
    now = (CYCLE + 20) * 1000;
    expect(c.time).toBeCloseTo(20, 5);
    expect(c.state().phase).toBe('Cold start');
  });
});
