/**
 * 本项目新增的唯一 re-export 入口（不改上面七个数学文件）。
 * 命名对齐 simple-statistics 的公开 API：sampleCorrelation / sampleVariance 等。
 */
import sampleCorrelation from './sample_correlation.js';
import sampleVariance from './sample_variance.js';
import sampleStandardDeviation from './sample_standard_deviation.js';
import sampleCovariance from './sample_covariance.js';
import mean from './mean.js';
import sum from './sum.js';
import sumNthPowerDeviations from './sum_nth_power_deviations.js';

export {
    sampleCorrelation,
    sampleVariance,
    sampleStandardDeviation,
    sampleCovariance,
    mean,
    sum,
    sumNthPowerDeviations,
};
