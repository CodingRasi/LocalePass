# Demo site

This tiny static site intentionally contains a couple of localization issues so you can test LocalePass quickly.

## Run it locally

From the `examples/demo-site` folder:

```bash
python3 -m http.server 3000
```

Then, from the repo root, use this config:

```json
{
  "baseUrl": "http://localhost:3000/examples/demo-site",
  "baselineLocale": "en",
  "outputDir": "reports/localepass",
  "pages": [
    { "name": "landing", "url": "/{locale}/index.html" },
    { "name": "pricing", "url": "/{locale}/pricing.html" }
  ],
  "locales": [
    { "name": "English", "code": "en", "headers": { "Accept-Language": "en" } },
    { "name": "German", "code": "de", "headers": { "Accept-Language": "de" } },
    { "name": "Japanese", "code": "ja", "headers": { "Accept-Language": "ja" } }
  ],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 1024 },
    { "name": "mobile", "width": 390, "height": 844 }
  ]
}
```
