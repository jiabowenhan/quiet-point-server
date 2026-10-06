/**
 * sampleCovariance — 样本协方差（n−1 分母）。
 * 直接复制自 simple-statistics（https://github.com/simple-statistics/simple-statistics，ISC）。
 */
import mean from './mean.js';

function sampleCovariance(x, y) {
    if (x.length !== y.length) {
        throw new Error('sampleCovariance requires samples with equal lengths');
    }

    if (x.length < 2) {
        throw new Error('sampleCovariance requires at least two data points');
    }

    var n = x.length;
    var xmean = mean(x);
    var ymean = mean(y);

    var sum = 0;
    for (var i = 0; i < n; i++) {
        sum += (x[i] - xmean) * (y[i] - ymean);
    }

    return sum / (n - 1);
}

export default sampleCovariance;
