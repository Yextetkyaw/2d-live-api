const axios = require('axios');
const cheerio = require('cheerio');
const { Redis } = require('@upstash/redis');

// Vercel Integration က ဆောက်ပေးလိုက်တဲ့ KV_REST_API_URL နှင့် KV_REST_API_TOKEN ကို သုံးပြီး ချိတ်ဆက်ခြင်း
const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', 'application/json');

    let timeData = { datetime: null, date: null, time: null };
    let marketStatus = "null";
    let set = "-";
    let value = "-";
    let twod = "null";
    let dataSource = "unknown";

    let hasHistory = false;
    let historyList = [];
    
    const defaultResult = {
        set: "--",
        value: "--",
        "2d": "--",
        datetime: "--",
        date: "--",
        time: "--",
        history_id: "--"
    };

    let noon_result = null;
    let evening_result = null;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    // ၁။ Time API ကနေ ဒေတာဆွဲခြင်း
    try {
        const timeResponse = await axios.get('https://time-api-42d.vercel.app/api/time', { timeout: 4000 });
        if (timeResponse.status === 200) {
            timeData = {
                datetime: timeResponse.data.formatted_datetime,
                date: timeResponse.data.date,
                time: timeResponse.data.time
            };
        }
    } catch (e) {}

    // ၂။ SET Home Page မှ ဒေတာဆွဲခြင်း
    let success = false;
    try {
        const response = await axios.get('https://www.set.or.th/en/home', { headers, timeout: 6000 });
        const $ = cheerio.load(response.data);

        $('div.text-black').each((i, el) => {
            const divText = $(el).text();
            if (divText.includes("Market Status")) {
                const spanText = $(el).find('span').text().trim();
                if (spanText) { marketStatus = spanText; return false; }
            }
        });

        $('tr').each((i, el) => {
            const indexTd = $(el).find('td.title-symbol');
            if (indexTd.length > 0 && indexTd.text().trim() === 'SET') {
                const tds = $(el).find('td');
                if (tds.length >= 5) {
                    set = $(tds[1]).text().trim();
                    value = $(tds[4]).text().trim();
                    dataSource = "home Page";
                    success = true;
                    return false;
                }
            }
        });
    } catch (e) { success = false; }

    // ၃။ Backup အဖြစ် Overview Page မှ ဆွဲခြင်း
    if (!success || set === "-" || value === "-") {
        try {
            const backupUrl = 'https://www.set.or.th/en/market/index/set/overview';
            const response = await axios.get(backupUrl, { headers, timeout: 6000 });
            const $ = cheerio.load(response.data);

            const setBox = $('.stock-info, .value.stock-info');
            if (setBox.length > 0) set = setBox.first().text().trim();

            const statusSpan = $('.quote-market-status span');
            if (statusSpan.length > 0) marketStatus = statusSpan.first().text().trim();

            const valueSpan = $('.quote-market-cost span');
            if (valueSpan.length > 0) value = valueSpan.text().trim();
            dataSource = "set overview";
        } catch (e) {}
    }

    // ၄။ 2D တွက်ချက်ခြင်း
    if (set !== "-") {
        const setLastDigit = set.slice(-1);
        let valueBeforeDecimalDigit = "-";

        if (value !== "-" && value.includes('.')) {
            const decimalIndex = value.indexOf('.');
            valueBeforeDecimalDigit = value.charAt(decimalIndex - 1);
        }

        if (value === "-") {
            twod = setLastDigit + "-";
        } else {
            twod = setLastDigit + valueBeforeDecimalDigit;
        }
    }
    if (marketStatus === "Closed") {
        set = "--"; value = "--"; twod = "--";
    }

    // ၅။ Redis ကိုသုံးပြီး History စီမံခန့်ခွဲခြင်း လုပ်ငန်းစဉ်
    try {
        let latestHistory = await redis.lindex('2d_history_list', 0);
        const hasHistoryInDb = await redis.exists('2d_history_list');

        // [စစ်ဆေးချက် ၁] ရက်အသစ်ရောက်လို့ 'ဖျက်မယ်' ဆိုရင်လည်း Database ထဲမှာ ဒေတာ "ရှိမှသာ" ဖျက်ပါမည်
        if (timeData.date && latestHistory && latestHistory.date !== timeData.date) {
            if (hasHistoryInDb) {
                await redis.del('2d_history_list');
            }
            
            const hasIdInDb = await redis.exists('next_history_id');
            if (hasIdInDb) {
                await redis.del('next_history_id');
            }
            latestHistory = null;
        }

        if (twod && twod !== "null" && twod !== "--" && twod !== "-") {
            let isDataChanged = true;

            if (latestHistory) {
                isDataChanged = latestHistory["2d"] !== twod || latestHistory["set"] !== set;
            }

            if (isDataChanged) {
                const nextHistoryId = await redis.incr('next_history_id');

                const newHistoryItem = {
                    set: set,
                    value: value,
                    "2d": twod,
                    datetime: timeData.datetime,
                    date: timeData.date,
                    time: timeData.time,
                    history_id: nextHistoryId
                };

                await redis.lpush('2d_history_list', newHistoryItem);
                await redis.ltrim('2d_history_list', 0, 49);
            }
        }

        historyList = await redis.lrange('2d_history_list', 0, 49);
        hasHistory = historyList.length > 0;

        // Database ထဲရှိ လက်ရှိ Noon/Evening ဒေတာဟောင်းများကို ဖတ်ယူစစ်ဆေးခြင်း
        const storedNoon = await redis.get('noon_result');
        const storedEvening = await redis.get('evening_result');

        // [စစ်ဆေးချက် ၂] ဈေးကွက်ဖွင့်ချိန်တွင် ဒေတာဟောင်းများကို 'ဖျက်မယ်' ဆိုပါကလည်း ဒေတာ "ရှိမှသာ" ဖျက်ပါမည်
        if (marketStatus !== "Closed") {
            if (storedNoon && timeData.date && storedNoon.date !== timeData.date) {
                await redis.del('noon_result');
            }
            if (storedEvening && timeData.date && storedEvening.date !== timeData.date) {
                await redis.del('evening_result');
            }
        }

        // ဖျက်ပြီးနောက် နောက်ဆုံးအခြေအနေကို Database ထံမှ ထပ်မံဖတ်ယူခြင်း
        noon_result = await redis.get('noon_result');
        evening_result = await redis.get('evening_result');

        // History List ထဲမှ အချိန်စစ်ပြီး ဒေတာရှာဖွေခြင်း
        for (let item of historyList) {
            const itemTime = item.time;

            if (itemTime) {
                // [စစ်ဆေးချက် ၃] ဒေတာ "မရှိမှသာ သွင်းမည်" (Database ရော၊ Variable ထဲမှာပါ မရှိမှ သွင်းပါမည်)
                if (!noon_result && !storedNoon && itemTime >= "12:01:00" && itemTime <= "12:01:30") {
                    noon_result = item;
                    await redis.set('noon_result', noon_result);
                }

                // [စစ်ဆေးချက် ၄] ဒေတာ "မရှိမှသာ သွင်းမည်" (Database ရော၊ Variable ထဲမှာပါ မရှိမှ သွင်းပါမည်)
                if (!evening_result && !storedEvening && itemTime >= "16:30:00" && itemTime <= "16:30:30") {
                    evening_result = item;
                    await redis.set('evening_result', evening_result);
                }
            }
            
            if (noon_result && evening_result) {
                break;
            }
        }

    } catch (redisError) {
        console.error("Redis Error:", redisError);
        historyList = [];
        hasHistory = false;
    }

    const finalNoonResult = noon_result ? noon_result : defaultResult;
    const finalEveningResult = evening_result ? evening_result : defaultResult;

    return res.status(200).json({
        live: {
            data_source: dataSource,
            status: marketStatus,
            set: set,
            value: value,
            "2d": twod,
            datetime: timeData.datetime,
            date: timeData.date,
            time: timeData.time
        },
        noon_result: finalNoonResult,
        evening_result: finalEveningResult,
        hasHistory: hasHistory,
        historyList: historyList
    });
};
