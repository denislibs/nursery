# showcase

Шесть страниц на чистых HTML, CSS и TypeScript без фреймворков. Каждая про одну боль браузерной
асинхронщины и то, как её закрывает `@nursery/core`. Бэкенд встроен в страницу, сети не нужно.

```bash
npm run showcase      # из корня репозитория, откроется http://localhost:5181
```

| Страница | Боль | Что показывает |
|---|---|---|
| `search.html` | устаревший ответ перетирает свежий | `latest`, `on` + `debounce`, таймлайн отменённых запросов |
| `table.html` | long task на секунды, ввод не обрабатывается | `chunked` с auto-бюджетом, fps-метр, счётчик кликов |
| `uploads.html` | нет паузы, приоритетов, отмены одного файла | `Queue`, `retry` с `onRetry`, `onUploadProgress` |
| `workers.html` | Comlink не отменяет, прогресс и transfer руками | `createPool`, `callback`, `transfer`, отмена внутри воркера |
| `dashboard.html` | кто держит страницу, запрос после unmount | `Nursery.child`, дедлайны, fail-fast, `close({ grace })`, `dump()` |
| `gestures.html` | isDragging-флаги и гонки таймеров | `on` + `for await`, `throttle`, `race`, `sleep` |
