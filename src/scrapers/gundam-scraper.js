// src/scrapers/gundam-scraper.js - Scraper for the official Gundam Card Game site.
//
// The Gundam Card Game (Bandai) has no public JSON API, so card data is scraped
// from https://www.gundam-gcg.com/en/cards. The flow mirrors how the API-backed
// games work elsewhere in TCGApi: discover "packages" (sets), then pull the cards
// for each package. A package's card list comes from a POST to index.php; each row
// links to a detail page that holds the full field set.
//
// This module owns all knowledge of the site's HTML/CSS. It returns normalized,
// still-raw card objects; TCGApi.parseGundamCardData maps those onto the database
// schema, keeping the DB-shape concern out of the scraper.

const axios = require('axios');
const cheerio = require('cheerio');

class GundamScraper {
    constructor() {
        this.baseUrl = 'https://www.gundam-gcg.com/en/cards';
        // A browser-like UA; the site is a public marketing/database page.
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (CardCast/1.0.0; +https://github.com/yzRobo/CardCast)',
            'Accept': 'text/html,application/xhtml+xml'
        };
    }

    /**
     * Sleep helper to stay polite to the server between requests.
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Resolve a (possibly relative) image src from a detail page to an absolute URL.
     * Detail pages live under /en/cards/, so "../images/..." resolves to /en/images/...
     */
    resolveImageUrl(src) {
        if (!src) return '';
        if (/^https?:\/\//i.test(src)) return src;
        if (src.startsWith('../')) {
            return 'https://www.gundam-gcg.com/en/' + src.replace(/^\.\.\//, '');
        }
        if (src.startsWith('/')) {
            return 'https://www.gundam-gcg.com' + src;
        }
        return `${this.baseUrl}/${src}`;
    }

    /**
     * Discover the list of card packages (sets) offered by the site filter.
     * The "Included In" filter renders each option as
     *   <a class="js-selectBtn-package" data-val="616101">Newtype Rising [GD01]</a>
     * Boosters use [GDxx] codes and starter/structure decks use [STxx] codes; both
     * are included (Bandai starter-deck cards are commonly played and shown on stream).
     *
     * @returns {Promise<Array<{id:string,name:string,code:string}>>}
     */
    async getPackages() {
        const response = await axios.get(`${this.baseUrl}/index.php`, {
            headers: this.headers,
            timeout: 30000
        });
        const $ = cheerio.load(response.data);

        const packages = [];
        const seen = new Set();
        $('a.js-selectBtn-package').each((i, el) => {
            const id = ($(el).attr('data-val') || '').trim();
            const name = $(el).text().replace(/\s+/g, ' ').trim();
            if (!id || seen.has(id)) return; // skip the empty "ALL" entry and dupes
            seen.add(id);
            // The set code lives in the trailing bracket, e.g. "... [GD01]".
            const codeMatch = name.match(/\[([^\]]+)\]\s*$/);
            const code = codeMatch ? codeMatch[1].toUpperCase() : '';
            packages.push({ id, name, code });
        });

        return packages;
    }

    /**
     * Fetch the detail-page links for every card in a package.
     * @param {Object} pkg { id, name, code }
     * @returns {Promise<string[]>} absolute detail URLs (deduped, in page order)
     */
    async getPackageCardLinks(pkg) {
        const listResponse = await axios.post(
            `${this.baseUrl}/index.php`,
            `package=${encodeURIComponent(pkg.id)}&freeword=`,
            {
                headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30000
            }
        );

        const $ = cheerio.load(listResponse.data);
        const links = [];
        const seen = new Set();
        $('.cardItem a.cardStr').each((i, el) => {
            const dataSrc = $(el).attr('data-src');
            if (!dataSrc) return;
            const url = `${this.baseUrl}/${dataSrc}`;
            if (seen.has(url)) return;
            seen.add(url);
            links.push(url);
        });
        return links;
    }

    /**
     * Parse a single card detail page into a normalized raw card object.
     * @param {string} html detail page HTML
     * @param {string} link the detail URL (source of the unique printing id)
     * @param {Object} pkg the package being scraped
     */
    parseDetail(html, link, pkg) {
        const $ = cheerio.load(html);

        // The detailSearch query param is the unique id per printing (alternate arts
        // share a card number but differ here, e.g. GD01-001 vs GD01-001_p1).
        const idMatch = link.match(/detailSearch=([^&]+)/);
        const productId = idMatch ? decodeURIComponent(idMatch[1]) : '';

        // Effect text: preserve line breaks that the site renders with <br>.
        let effectHtml = $('.cardDataRow.overview .dataTxt.isRegular').html() || '';
        effectHtml = effectHtml.replace(/<br\s*\/?>/gi, '\n');
        const effect = cheerio.load(effectHtml).text().replace(/\n{3,}/g, '\n\n').trim();

        const image = this.resolveImageUrl($('.cardImage img').attr('src'));

        // Collect every labelled stat row as { "Lv.": "4", "COST": "3", ... }.
        // TCGApi maps these labels onto the gd_* columns.
        const fields = {};
        $('.dataBox').each((i, el) => {
            const label = $(el).find('.dataTit').text().replace(/\s+/g, ' ').trim();
            const value = $(el).find('.dataTxt').text().replace(/\s+/g, ' ').trim();
            if (label) fields[label] = value;
        });

        return {
            product_id: productId,
            card_number: $('.cardNoCol .cardNo').text().trim() || productId,
            name: $('.nameCol .cardName').text().trim(),
            rarity: $('.cardNoCol .rarity').text().replace(/\s+/g, ' ').trim(),
            sp: $('.cardNoCol .spCol').text().replace(/\s+/g, ' ').trim(),
            blockIcon: $('.cardNoCol .blockIcon').text().trim(),
            image,
            effect,
            fields,
            source_package: pkg.name,
            set_code: pkg.code || (productId.split('-')[0] || '').toUpperCase(),
            detail_url: link
        };
    }

    /**
     * Scrape every card in a package. Detail pages are fetched in small concurrent
     * batches to keep the (potentially hundreds of) requests reasonable while still
     * being polite to the server.
     * @param {Object} pkg { id, name, code }
     * @param {Object} [options] { onProgress?, limit?, batchSize?, batchDelay? }
     * @returns {Promise<Array>} normalized raw card objects
     */
    async scrapePackage(pkg, options = {}) {
        const batchSize = options.batchSize || 5;
        const batchDelay = options.batchDelay != null ? options.batchDelay : 250;

        let links = await this.getPackageCardLinks(pkg);
        if (options.limit) {
            links = links.slice(0, options.limit);
        }
        console.log(`Gundam ${pkg.code || pkg.name}: ${links.length} cards`);

        const cards = [];
        for (let i = 0; i < links.length; i += batchSize) {
            const batch = links.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (link) => {
                try {
                    const resp = await axios.get(link, { headers: this.headers, timeout: 30000 });
                    return this.parseDetail(resp.data, link, pkg);
                } catch (err) {
                    console.error(`Failed to fetch Gundam detail ${link}:`, err.message);
                    return null;
                }
            }));

            for (const card of results) {
                if (card && card.product_id) cards.push(card);
            }

            if (typeof options.onProgress === 'function') {
                options.onProgress(Math.min(i + batchSize, links.length), links.length);
            }

            // Pause between batches (skip the wait after the final batch).
            if (i + batchSize < links.length) {
                await this.delay(batchDelay);
            }
        }

        return cards;
    }
}

module.exports = GundamScraper;
