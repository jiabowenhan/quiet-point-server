/**
 * sampleCorrelation — 皮尔逊积矩相关系数。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
import sampleCovariance from './sample_covariance.js';
import sampleStandardDeviation from './sample_standard_deviation.js';

function sampleCorrelation(x, y) {
    var cov = sampleCovariance(x, y);
    var xstd = sampleStandardDeviation(x);
    var ystd = sampleStandardDeviation(y);

    return cov / xstd / ystd;
}

export default sampleCorrelation;
