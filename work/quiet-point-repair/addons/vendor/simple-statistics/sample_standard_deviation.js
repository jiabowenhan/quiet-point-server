/**
 * sampleStandardDeviation — 样本标准差。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
import sampleVariance from './sample_variance.js';

function sampleStandardDeviation(x) {
    var sampleVarianceX = sampleVariance(x);
    return Math.sqrt(sampleVarianceX);
}

export default sampleStandardDeviation;
