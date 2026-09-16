/**
 * 美团商家月售采集：无障碍节点版。
 *
 * 使用前：
 * 1. 打开美团美食商家列表。
 * 2. 开启并确认 AutoJs6 无障碍服务正在运行。
 *
 * 列表节点中有月售时直接保存；没有月售时进入详情页读取“月售”字段。
 */
!function collectMeituanMerchantMetrics() {
    'use strict';

    const currentEngine = engines.myEngine();
    const currentSource = String(currentEngine.getSource());
    engines.all().forEach(engine => {
        if (engine.getId() !== currentEngine.getId() && String(engine.getSource()) === currentSource) {
            console.warn('检测到另一实例，停止旧的 meituan.js 任务。');
            engine.forceStop();
        }
    });

    const DATABASE_VERSION = 13;
    const CONFIG = {
        viewports: 8,
        firstListTop: Math.floor(device.height * 0.64),
        scrolledListTop: Math.floor(device.height * 0.12),
        listBottom: Math.floor(device.height * 0.99),
        titleMinWidth: Math.floor(device.width * 0.20),
        titleLeft: Math.floor(device.width * 0.34),
        titleMaxLeft: Math.floor(device.width * 0.48),
        titleToMetadataMaxY: 280,
        settleDelayMs: [1200, 1800],
        detailLoadDelayMs: 1800,
        detailRetries: 3,
        outputPath: files.join(files.getSdcardPath(), 'Download', 'meituan_merchants_ocr.json'),
        databasePath: files.join(files.getSdcardPath(), 'Download', 'meituan_merchant_db.json'),
    };

    console.show();
    const database = loadDatabase();
    const existingMerchantKeys = Object.keys(database.merchants).reduce((keys, key) => {
        keys[key] = true;
        return keys;
    }, {});
    console.log('请保持在美团商家列表页，3 秒后开始采集。');
    sleep(3000);

    for (var viewport = 1; viewport <= CONFIG.viewports; viewport++) {
        var viewportCards = collectVisibleMerchantCards(viewport);
        console.log(`视口 ${viewport}/${CONFIG.viewports}：节点识别到 ${viewportCards.length} 个商家。`);

        // 第一阶段：先写入本视口所有商家，详情跳转不会影响已识别的新店。
        for (var writeIndex = 0; writeIndex < viewportCards.length; writeIndex++) {
            writeListMerchant(viewportCards[writeIndex], viewport);
        }

        // 第二阶段：仅对列表中缺月售且未尝试详情的商家补齐。
        viewportCards.sort((a, b) => b.title.bounds.top - a.title.bounds.top);
        for (var detailIndex = 0; detailIndex < viewportCards.length; detailIndex++) {
            fillMissingSalesFromDetail(viewportCards[detailIndex], viewport);
        }

        if (viewport < CONFIG.viewports) {
            if (!scrollListByGesture()) {
                console.warn('手势滑动失败，停止采集。请确认 AutoJs6 无障碍服务正在运行。');
                break;
            }
            sleep(randomInt(CONFIG.settleDelayMs[0], CONFIG.settleDelayMs[1]));
        }
    }

    writeDatabaseAndResults();
    toastLog(`采集完成：${Object.keys(database.merchants).length} 条`);

    function collectVisibleMerchantCards(viewport) {
        const listTop = viewport === 1 ? CONFIG.firstListTop : CONFIG.scrolledListTop;
        const nodes = visibleTextNodes();
        const titles = nodes
            .filter(node => node.bounds.top >= listTop && node.bounds.bottom <= CONFIG.listBottom)
            .filter(isMerchantTitle)
            .filter(title => hasCardMetadata(title, nodes))
            .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
        var collectedCards = [];
        const seen = {};

        // 月售节点是最稳定的卡片锚点：向上匹配同一卡片最近的店名。
        var salesAnchors = nodes
            .filter(node => node.bounds.top >= listTop && node.bounds.bottom <= CONFIG.listBottom)
            .filter(node => extractMonthlySales(node.text))
            .sort((a, b) => a.bounds.top - b.bounds.top);
        console.warn(`[节点诊断][视口 ${viewport}] ${JSON.stringify({
            listTop,
            salesTexts: nodes
                .filter(node => /月|售|销/.test(node.text))
                .map(node => ({ text: node.text, top: node.bounds.top, parsed: extractMonthlySales(node.text) })),
            titleTexts: titles.map(title => ({ text: title.text, top: title.bounds.top })),
            salesAnchorCount: salesAnchors.length,
        })}`);

        for (var salesIndex = 0; salesIndex < salesAnchors.length; salesIndex++) {
            var salesNode = salesAnchors[salesIndex];
            var salesTitle = closestTitleAbove(salesNode, titles);
            if (!salesTitle) {
                continue;
            }
            var salesCard = {
                name: salesTitle.text,
                title: salesTitle,
                monthlySales: extractMonthlySales(salesNode.text),
                distance: nearestDistanceBelow(salesNode, nodes),
                bounds: {
                    left: salesTitle.bounds.left,
                    top: salesTitle.bounds.top,
                    right: salesTitle.bounds.right,
                    bottom: salesNode.bounds.bottom,
                },
            };
            var salesKey = merchantKey(salesCard.name);
            if (!salesKey || seen[salesKey]) {
                continue;
            }
            seen[salesKey] = true;
            collectedCards.push(salesCard);
        }

        // 保留列表未展示月售的店，后续进入详情页兜底。
        for (var titleIndex = 0; titleIndex < titles.length; titleIndex++) {
            var missingTitle = titles[titleIndex];
            var missingKey = merchantKey(missingTitle.text);
            if (!missingKey || seen[missingKey]) {
                continue;
            }
            collectedCards.push({
                name: missingTitle.text,
                title: missingTitle,
                monthlySales: null,
                distance: nearestDistanceBelow(missingTitle, nodes),
                bounds: missingTitle.bounds,
            });
            seen[missingKey] = true;
        }

        console.log(`[视口 ${viewport}] 节点商家：${JSON.stringify(collectedCards.map(card => ({
            name: card.name,
            monthlySales: card.monthlySales,
            distance: card.distance,
            bounds: card.bounds,
        })))}`);
        return collectedCards;
    }

    function closestTitleAbove(anchor, titles) {
        const candidates = titles
            .filter(title => title.bounds.top <= anchor.bounds.top)
            .filter(title => anchor.bounds.top - title.bounds.top <= 180);
        return candidates.length ? candidates[candidates.length - 1] : null;
    }

    function nearestDistanceBelow(anchor, nodes) {
        const candidate = nodes
            .filter(node => node.bounds.top >= anchor.bounds.top)
            .filter(node => node.bounds.top - anchor.bounds.top <= 160)
            .map(node => ({ node, distance: extractDistance(node.text) }))
            .filter(item => item.distance)
            .sort((a, b) => a.node.bounds.top - b.node.bounds.top)[0];
        return candidate ? candidate.distance : null;
    }

    function visibleTextNodes() {
        const root = auto.rootInActiveWindow;
        if (!root) {
            console.error('未获取到活动窗口节点。请确认无障碍服务正在运行。');
            return [];
        }
        return Array.from(root.find())
            .map(node => toNodeRecord(node))
            .filter(node => node.text)
            .filter(node => node.bounds.top >= 0 && node.bounds.top < device.height)
            .filter(node => node.bounds.bottom > node.bounds.top && node.bounds.bottom <= device.height)
            .sort((a, b) => a.bounds.top - b.bounds.top || a.bounds.left - b.bounds.left);
    }

    function toNodeRecord(node) {
        const bounds = node.bounds();
        return {
            node,
            text: String(node.text() || node.desc() || '').replace(/\s+/g, '').trim(),
            bounds: {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
            },
        };
    }

    function isMerchantTitle(record) {
        const width = record.bounds.right - record.bounds.left;
        return record.bounds.left >= CONFIG.titleLeft
            && record.bounds.left <= CONFIG.titleMaxLeft
            && width >= CONFIG.titleMinWidth
            && record.text.length >= 3
            && !isCardMetadata(record.text);
    }

    function hasCardMetadata(title, nodes) {
        return nodes.some(node =>
            node.bounds.top >= title.bounds.top
            && node.bounds.top <= title.bounds.top + CONFIG.titleToMetadataMaxY
            && /月[售销]|起送|配送|美团快送|堂食店|明厨亮灶|\d+(?:\.\d+)?分/.test(node.text),
        );
    }

    function isCardMetadata(text) {
        return /月[售销]|起送|配送|美团快送|堂食店|无堂食|明厨亮灶|神券|满\d|减\d|评分|评价|优惠|推荐|广告|平台|食安|严管|放心|最近\d|近期\d|\d+人(?:觉得|好评|下单|看过)|用户.*(?:看过|好评|下单)|刚刚有用户看过|附近美食|高分店铺|高分商家|分钟|商家排行|排行榜|^\d+(?:\.\d+)?分/.test(text);
    }

    function writeListMerchant(card, viewport) {
        const key = resolveMerchantKey(card.name, card.monthlySales);
        const previous = database.merchants[key];
        if (existingMerchantKeys[key]) {
            console.log(`断点续传跳过已有商家：${card.name}`);
            return;
        }
        upsertMerchant({
            key,
            name: card.name,
            monthlySales: card.monthlySales || (previous && previous.monthlySales),
            distance: card.distance || (previous && previous.distance),
            viewport,
            source: card.monthlySales ? 'list-node' : 'list-node-no-sales',
            detailAttempted: previous && previous.detailAttempted,
        });
    }

    function fillMissingSalesFromDetail(card, viewport) {
        const key = resolveMerchantKey(card.name, card.monthlySales);
        const merchant = database.merchants[key];
        if (existingMerchantKeys[key] || !merchant || merchant.monthlySales || merchant.detailAttempted) {
            return;
        }
        const currentTitle = visibleTextNodes().find(node => node.text === card.name) || card.title;
        const clickable = findClickableParent(currentTitle.node);
        if (!clickable) {
            console.warn(`未找到可点击卡片祖先：${card.name}`);
            return;
        }

        console.log(`详情兜底：${card.name}`);
        const detailResult = readMonthlySalesFromDetail(clickable, card.name);
        upsertMerchant({
            key,
            name: card.name,
            monthlySales: detailResult.monthlySales,
            distance: merchant.distance || card.distance,
            viewport,
            source: detailResult.monthlySales ? 'detail-node' : 'detail-node-no-sales',
            detailAttempted: detailResult.attempted,
        });
    }

    function findClickableParent(node) {
        let current = node;
        for (let level = 0; level < 8 && current; level++) {
            if (current.clickable()) {
                return current;
            }
            current = current.parent();
        }
        return null;
    }

    function readMonthlySalesFromDetail(clickable, name) {
        try {
            if (!clickable.click()) {
                return { monthlySales: null, attempted: false };
            }
        } catch (error) {
            console.error(`点击详情失败：${name}，${error}`);
            return { monthlySales: null, attempted: false };
        }

        sleep(CONFIG.detailLoadDelayMs);
        let monthlySales = null;
        for (let attempt = 1; attempt <= CONFIG.detailRetries && !monthlySales; attempt++) {
            const nodes = visibleTextNodes();
            if (detailPageMatchesMerchant(nodes, name)) {
                monthlySales = extractDetailMonthlySales(nodes);
            }
            console.log(`详情节点第 ${attempt} 次：${name}，月售=${monthlySales || '未识别'}`);
            if (!monthlySales) {
                sleep(700);
            }
        }

        try {
            back();
            sleep(1000);
        } catch (error) {
            console.error(`详情返回失败：${name}，${error}`);
        }
        return { monthlySales, attempted: true };
    }

    function extractDetailMonthlySales(nodes) {
        const inline = firstMonthlySales(nodes);
        if (inline) {
            return inline;
        }
        const label = nodes.find(node => /^月[售销]$/.test(node.text));
        if (!label) {
            return null;
        }
        const valueNode = nodes
            .filter(node => Math.abs(centerY(node) - centerY(label)) <= 150)
            .filter(node => node.bounds.left >= label.bounds.left - 100 && node.bounds.left <= label.bounds.right + 420)
            .map(node => extractSalesValue(node.text))
            .find(value => value);
        return valueNode ? `月售${valueNode}` : null;
    }

    function detailPageMatchesMerchant(nodes, name) {
        const key = merchantKey(name);
        const token = key.slice(0, Math.min(key.length, 6));
        return token.length >= 4 && nodes.some(node => merchantKey(node.text).indexOf(token) >= 0);
    }

    function firstMonthlySales(nodes) {
        for (let i = 0; i < nodes.length; i++) {
            const monthlySales = extractMonthlySales(nodes[i].text);
            if (monthlySales) {
                return monthlySales;
            }
        }
        return null;
    }

    function extractMonthlySales(text) {
        const source = String(text);
        const labelIndex = Math.max(source.indexOf('月售'), source.indexOf('月销'));
        if (labelIndex < 0) {
            return null;
        }
        const value = extractSalesValue(source.substring(labelIndex + 2));
        return value ? `月售${value}` : null;
    }

    function extractSalesValue(text) {
        const match = String(text).match(/[0-9]+(?:\.[0-9]+)?(?:万)?\+?/);
        return match ? match[0] : null;
    }

    function firstDistance(nodes) {
        for (let i = 0; i < nodes.length; i++) {
            const distance = extractDistance(nodes[i].text);
            if (distance) {
                return distance;
            }
        }
        return null;
    }

    function extractDistance(text) {
        const matches = String(text).match(/\d+(?:\.\d+)?(?:km|千米|m|米)/ig);
        return matches && matches.length ? normalizeDistance(matches[matches.length - 1]) : null;
    }

    function normalizeDistance(text) {
        return String(text).replace(/千米/i, 'km').replace(/米$/i, 'm');
    }

    function scrollListByGesture() {
        const x = randomInt(Math.floor(device.width * 0.44), Math.floor(device.width * 0.56));
        try {
            const result = Boolean(gesture(
                randomInt(650, 850),
                [x, Math.floor(device.height * 0.78)],
                [x + randomInt(-25, 25), Math.floor(device.height * 0.52)],
                [x + randomInt(-35, 35), Math.floor(device.height * 0.30)],
            ));
            console.log(`随机上滑结果：${result}`);
            return result;
        } catch (error) {
            console.error(`随机上滑失败：${error}`);
            return false;
        }
    }

    function upsertMerchant(merchant) {
        const key = resolveMerchantKey(merchant.name, merchant.monthlySales);
        const previous = database.merchants[key] || {};
        database.merchants[key] = {
            name: longerMerchantName(previous.name, merchant.name),
            monthlySales: merchant.monthlySales || previous.monthlySales || null,
            distance: merchant.distance || previous.distance || null,
            viewport: merchant.viewport,
            source: merchant.source || previous.source || 'unknown',
            detailAttempted: Boolean(merchant.detailAttempted || previous.detailAttempted),
            updatedAt: new Date().toISOString(),
        };
        writeDatabaseAndResults();
        console.log(`写入商家：${JSON.stringify(database.merchants[key])}`);
    }

    function writeDatabaseAndResults() {
        const merchants = Object.keys(database.merchants)
            .map(key => database.merchants[key])
            .sort((a, b) => a.name.localeCompare(b.name));
        const now = new Date().toISOString();
        files.createWithDirs(CONFIG.databasePath);
        files.write(CONFIG.databasePath, JSON.stringify({
            version: DATABASE_VERSION,
            updatedAt: now,
            merchants: database.merchants,
        }, null, 2));
        files.createWithDirs(CONFIG.outputPath);
        files.write(CONFIG.outputPath, JSON.stringify({
            generatedAt: now,
            count: merchants.length,
            merchants,
        }, null, 2));
    }

    function loadDatabase() {
        if (!files.exists(CONFIG.databasePath)) {
            return { merchants: {} };
        }
        try {
            const stored = JSON.parse(files.read(CONFIG.databasePath));
            if (stored && stored.version === DATABASE_VERSION && stored.merchants) {
                purgeTagRecords(stored.merchants);
                mergeTruncatedMerchantRecords(stored.merchants);
                return stored;
            }
        } catch (error) {
            console.warn(`店名数据库读取失败：${error}`);
        }
        console.warn('店名数据库版本已更新，将忽略旧采集结果。');
        return { merchants: {} };
    }

    function purgeTagRecords(merchants) {
        Object.keys(merchants).forEach(key => {
            if (isCardMetadata(merchants[key].name)) {
                console.warn(`清理历史标签记录：${merchants[key].name}`);
                delete merchants[key];
            }
        });
    }

    function mergeTruncatedMerchantRecords(merchants) {
        const keys = Object.keys(merchants);
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                const firstKey = keys[i];
                const secondKey = keys[j];
                if (!merchants[firstKey] || !merchants[secondKey]
                    || !sameMerchantPrefix(firstKey, secondKey)
                    || !sameMonthlySales(merchants[firstKey].monthlySales, merchants[secondKey].monthlySales)) {
                    continue;
                }
                const targetKey = firstKey.length >= secondKey.length ? firstKey : secondKey;
                const sourceKey = targetKey === firstKey ? secondKey : firstKey;
                const target = merchants[targetKey];
                const source = merchants[sourceKey];
                merchants[targetKey] = {
                    name: longerMerchantName(target.name, source.name),
                    monthlySales: target.monthlySales || source.monthlySales || null,
                    distance: target.distance || source.distance || null,
                    viewport: target.viewport || source.viewport,
                    source: target.source || source.source,
                    detailAttempted: Boolean(target.detailAttempted || source.detailAttempted),
                    updatedAt: target.updatedAt || source.updatedAt,
                };
                delete merchants[sourceKey];
                console.warn(`合并截断店名（相同月售）：${source.name} -> ${merchants[targetKey].name}`);
            }
        }
    }

    function resolveMerchantKey(name, monthlySales) {
        const key = merchantKey(name);
        if (!monthlySales) {
            return key;
        }
        const existingKey = Object.keys(database.merchants)
            .filter(candidate => sameMerchantPrefix(candidate, key))
            .filter(candidate => sameMonthlySales(database.merchants[candidate].monthlySales, monthlySales))
            .sort((a, b) => b.length - a.length)[0];
        return existingKey || key;
    }

    function sameMerchantPrefix(first, second) {
        const minimumLength = Math.min(first.length, second.length);
        return minimumLength >= 10 && (first.indexOf(second) === 0 || second.indexOf(first) === 0);
    }

    function sameMonthlySales(first, second) {
        return Boolean(first) && first === second;
    }

    function longerMerchantName(first, second) {
        const firstName = String(first || '');
        const secondName = String(second || '');
        return merchantNameLength(secondName) > merchantNameLength(firstName) ? secondName : firstName || secondName;
    }

    function merchantNameLength(name) {
        return String(name).replace(/[^0-9a-z\u4e00-\u9fa5]/gi, '').length;
    }

    function centerY(record) {
        return (record.bounds.top + record.bounds.bottom) / 2;
    }

    function merchantKey(name) {
        return String(name)
            .replace(/[^0-9a-z\u4e00-\u9fa5]/gi, '')
            .slice(0, 18)
            .toLowerCase();
    }

    function randomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
}();
