const express = require('express');
const app = express();
app.use(express.json());

const { Cluster } = require('puppeteer-cluster');
const CHC = require('chrome-har-capturer');

async function build_har_client(page, events) {
    // Code borrowed partially from issue:
    // https://github.com/cyrus-and/chrome-har-capturer/issues/75

    const client = await page.target().createCDPSession();
    const watchedEvents = [
        'Network.dataReceived',
        'Network.loadingFailed',
        'Network.loadingFinished',
        'Network.requestWillBeSent',
        'Network.resourceChangedPriority',
        'Network.responseReceived',
        'Page.domContentEventFired',
        'Page.loadEventFired'
    ];

    await client.send('Page.enable');
    await client.send('Network.enable');

    watchedEvents.forEach(method => {
        client.on(method, params => {
            events.push({ method, params });
        });
    });

    const fetchResponseBody = async ({ requestId, encodedDataLength }) => {
        // Reference for CDT events and methods https://chromedevtools.github.io/devtools-protocol/tot/Network/
        // call Network.getResponsebody manually for each
        // Network.loadingFinished events
        // Handle redirects gracefully ( no body) - check for body size
        if (encodedDataLength) {
            const params = await client.send('Network.getResponseBody', { requestId });
            // build the synthetic events
            let body = params.body.toString()
            const base64Encoded = params.base64Encoded;

            // Lets encode potential binary data in base64 as binary in JSON is not nice
            if (!base64Encoded) {
                body = body.toString('base64');
            }

            events.push({
                method: 'Network.getResponseBody',
                params: {
                    requestId,
                    body,
                    base64Encoded
                }
            });
        }
    }

    await client.on('Network.loadingFinished', fetchResponseBody);
    return client;
}

const scrape_task = async ({ page, data: args }) => {
    if (!args.url) {
        console.log("No url provided");
        return
    }
    // set cookies
    if (args.cookies) {
        await page.setCookie(args.cookies[0]);
    }

    item = {}

    if (args.useragent) {
        item['useragent'] = args.useragent
        page.setUserAgent(args.useragent);
    }

    // Build HAR generator
    let events = []
    const client = await build_har_client(page, events);

    if (args.referer) {
        page.setExtraHTTPHeaders({ referer: args.referer})
    }

    const url = args.url
    const response = await page.goto(url);

    // Last url in redirection chain
    const chain = response.request().redirectChain();
    const last_redir = chain.at(-1)
    if (last_redir) {
        item['last_redirected_url'] = last_redir.url()
    } else {
        item['last_redirected_url'] = url;
    }
        
    // Wait x milliseconds
    if (args.sleep) {
        await page.waitForTimeout(args.sleep)
    }

    // Make a screenshot
    const screen = await page.screenshot();
    const screenstr = screen.toString('base64');
    item['png'] = screenstr

    // dump HTML
    item['html'] = await page.content();

    // cookies
    item['cookies'] = await page.cookies();
    await client.detach();
    await page.close();

    // HAR
    item['har'] = await CHC.fromLog(url, events, { content: true }).catch(e =>
           {
               console.error("Something went wrong when creating HAR file: " + e);
           });

    return item;
}

(async () => {
    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_CONTEXT,
        maxConcurrency: 2,
        puppeteerOptions: {
            executablePath: '/usr/bin/chromium-browser'
        },
    });

    // TODO: proxy support

    await cluster.task(scrape_task);

    // setup server
    app.post('/', async function (req, res) {
        let results = []
        try {
            console.log(req.body)
            // SECURE
            const result = await cluster.execute(req.body);
            results.push(result);

            res.json(results);
        } catch (err) {
                res.end('Error: ' + err.message);
                console.log(err);
        }
    });

    app.listen(3000, function () {
        console.log('Screenshot server listening on port 3000.');
    });
})();
