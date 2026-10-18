import { retentionReserve, splitUsagePeriod, type Rates } from '@cloudbrowser/contracts';
import { describe, expect, it } from 'vitest';

describe('AWS monthly usage units and refundable retention reserves', () => {
  it.each([
    ['2026-10-01','2026-11-01',31*24],
    ['2026-02-01','2026-03-01',28*24],
    ['2028-02-01','2028-03-01',29*24],
  ])('meters exactly one GB-month for %s through %s', (from,to,hours) => {
    const slices=splitUsagePeriod(new Date(from),new Date(to));
    expect(slices.reduce((a,s)=>a+s.hours,0)).toBe(hours);
    expect(slices.reduce((a,s)=>a+s.monthFraction,0)).toBeCloseTo(1,12);
  });

  it('separates UTC day and calendar month boundaries without rounding to a whole hour', () => {
    const slices=splitUsagePeriod(new Date('2026-10-31T23:59:30Z'),new Date('2026-11-01T00:00:30Z'));
    expect(slices).toHaveLength(2);
    expect(slices[0]!.day).toBe('2026-10-31');
    expect(slices[1]!.day).toBe('2026-11-01');
    expect(slices[0]!.hours).toBe(30/3600);
    expect(slices[0]!.monthFraction).toBe(30/(31*86400));
    expect(slices[1]!.monthFraction).toBe(30/(30*86400));
  });

  it('never turns an empty or reversed period into a charge', () => {
    expect(splitUsagePeriod(new Date(1000),new Date(1000))).toEqual([]);
    expect(splitUsagePeriod(new Date(1000),new Date(0))).toEqual([]);
    expect(()=>splitUsagePeriod(new Date('invalid'),new Date())).toThrow(RangeError);
  });

  it('reserves the actual next seven days, independent of compute charges', () => {
    const rates:Rates={compute:999999,ip:5000,storage:96000,snapshot:55000,transfer:114000};
    const spec={storageGb:10,rootVolumeGb:16,backups:false};
    const now=new Date('2026-10-29T00:00:00Z');
    const expected=Math.ceil(5000*168+96000*26*(3/31+4/30));
    expect(retentionReserve(rates,spec,now)).toBe(expected);
    expect(retentionReserve({...rates,compute:0,transfer:0},spec,now)).toBe(expected);
  });
});
