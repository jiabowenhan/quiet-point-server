/** 裁剪复用 simple-statistics 时的最小 TS 声明（本项目新增；数学实现在同名 .js 里保持原样）。 */
export declare function sampleCorrelation(x: readonly number[], y: readonly number[]): number;
export declare function sampleVariance(x: readonly number[]): number;
export declare function sampleStandardDeviation(x: readonly number[]): number;
export declare function sampleCovariance(x: readonly number[], y: readonly number[]): number;
export declare function mean(x: readonly number[]): number;
export declare function sum(x: readonly number[] | Record<string, number>): number;
export declare function sumNthPowerDeviations(x: readonly number[], n: number): number;
