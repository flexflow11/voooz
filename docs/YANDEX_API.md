# Yandex AI Studio: контракт серверного адаптера

Адаптер `server/yandex.mjs` обращается к **Yandex**, хотя формат API совместим с OpenAI. Запросы в OpenAI он не отправляет.

- Endpoint: `POST https://ai.api.cloud.yandex.net/v1/responses`.
- Авторизация совместимого API: `Authorization: Bearer <API key>`, `OpenAI-Project: <folder ID>`, как в официальном примере с OpenAI SDK.
- Модель по умолчанию: `gpt://<folder ID>/yandexgpt/latest`. При настройке можно передать `yandexgpt/latest` либо полный URI из этого же каталога.
- Веб-поиск: `tools: [{type: "web_search", search_context_size: "high", filters: {allowed_domains: [...]}}]`. Фильтр применяется, когда в запросе есть от одного до пяти официальных доменов. При большем списке он не обрезается; поиск выполняется без фильтра, проверка официальности результата остается обязательной на сервере.
- `tool_choice: {type: "web_search"}` требует использовать поиск. Ответ запрашивается в JSON: `text: {format: {type: "json_object"}}`.
- Источники извлекаются исключительно из метаданных ответа провайдера: `content[].annotations[]` с `type: "url_citation"` и `url` либо `web_search_call.action.sources`. Массив `sources` внутри сгенерированного JSON источником подтверждения не является. Адреса без схемы в аннотациях нормализуются в HTTPS: такой формат приведен в документации Yandex.
- `store: false`: адаптер не запрашивает сохранение диалога в Responses API. Это не утверждение об отсутствии иных журналов у поставщика.
- Таймаут 55 секунд; размер ответа до 2 MiB; одновременно не более восьми разных поисков. Идентичные запросы объединяются. Локальный кеш ответов действует 24 часа, до 128 записей в памяти и на диске. Ключ API в кеш не записывается. Кеш может содержать персонализированные объяснения; на сервере каталог `.cache` должен оставаться закрытым и может отключаться.

Для живого использования нужны собственный каталог Yandex Cloud, API-ключ сервисного аккаунта с доступом к модели и Responses API, активный платежный аккаунт и доступные квоты. Веб-поиск также расходует квоты Search API. Значения ключей добавляются только в серверные секреты: не в HTML, публичный репозиторий или переменные Vite.

Сохраненный HTML работает без сервера и не содержит ключа; поэтому сам по себе он не выполняет платные обращения к нейросети. В приложении на сервере браузер обращается к собственному `/api`, а уже Node.js — в Yandex.

## Официальные источники

Проверено 22.10.2026. Текущая документация AI Studio перенесена на `aistudio.yandex.ru/docs/ru/`; доступ к ней из среды разработки закрыт сетевым прокси. Ниже доступны официальные исходники Yandex, на основании которых реализован запрос. Это проверка контракта по документации и тестам с подставным провайдером; без ключа живой запрос не выполнялся.

1. [Responses create: точный HTTP endpoint и параметры](https://github.com/yandex-cloud/docs/blob/3f9fad86743ef875b054c9213e1b007c90821249/ru/ai-studio/responses/createResponse.md).
2. [Создание агента с веб-поиском: OpenAI SDK, API key, project и модель](https://github.com/yandex-cloud/docs/blob/3f9fad86743ef875b054c9213e1b007c90821249/ru/ai-studio/operations/agents/create-websearch-text-agent.md).
3. [Web Search: до пяти доменов, квоты Search API, формат annotations/url](https://github.com/yandex-cloud/docs/blob/3f9fad86743ef875b054c9213e1b007c90821249/ru/ai-studio/concepts/agents/tools/websearch.md).
4. [Аутентификация и роли: ai.assistants.editor, ai.languageModels.user](https://github.com/yandex-cloud/docs/blob/3f9fad86743ef875b054c9213e1b007c90821249/ru/_includes/ai-studio/ai-before-beginning.md). У специализированных API Yandex есть схема `Api-Key`; в совместимом Responses API использована схема официального примера OpenAI SDK — `Bearer`.
5. [Текущие имена хостов/адрес документации в исходниках Yandex](https://github.com/yandex-cloud/docs/blob/master/ru/presets.yaml): `api-host-llm: ai.api.cloud.yandex.net`, `link-docs-ai: https://aistudio.yandex.ru/docs/ru/`.
