---
layout: post.njk
title: "Construire un service de health check en Python avec asyncio"
description: "Un petit service qui poll une liste d'URLs en parallèle, stocke les résultats en mémoire et les expose via une API FastAPI."
date: 2026-07-04
tags: [python, asyncio, fastapi, docker]
---

Un *health check* est un service qui surveille en continu si une liste d'URLs répond correctement. L'objectif : savoir en temps réel qu'un service est tombé, avant que les utilisateurs ne s'en rendent compte.

Dans ce post, nous allons construire un petit service en Python qui :

1. Poll une liste d'URLs configurables à intervalle régulier
2. Le fait **en parallèle** pour qu'une URL lente n'en bloque pas d'autres
3. Stocke les résultats en mémoire
4. Les expose via une API HTTP `/status`

Le tout packagé dans un container Docker durci, prêt à tourner.

## Prérequis

- Python 3.13
- Des bases en `async`/`await`
- Un `Dockerfile` (on le verra)
- De quoi éditer un fichier YAML

---

## L'architecture en un coup d'œil

Avant de coder, il faut séparer les responsabilités. Quatre modules, chacun avec un seul rôle :

```
python/
└── app/
    ├── config.py   # charge et valide le YAML
    ├── data.py     # le store en mémoire
    ├── worker.py   # le worker async qui poll
    └── api.py      # l'API FastAPI + le lifespan
```

L'idée directrice : le **worker** écrit dans le **store**, l'**API** lit dans le **store**. Les deux ne se parlent jamais directement, ils passent par la donnée. Ça garde le code découplé et testable.

---

## Étape 1 : Charger la configuration

On veut pouvoir éditer la liste des URLs sans retoucher au code. Un simple YAML fait l'affaire.

```yaml
urls:
  - https://httpbin.org/status/200
  - https://httpbin.org/status/503
  - https://jsonplaceholder.typicode.com/posts/1

pollInterval: 60   # secondes entre chaque poll
timeout: 10        # secondes avant de marquer TIMEOUT
```

Et le loader qui va avec :

```python
class Config:
    def __init__(self, path: str = "config.yaml"):
        with open(path) as stream:
            try:
                data = yaml.safe_load(stream) or {}
            except yaml.YAMLError as e:
                raise ValueError(f"Error while loading yaml file: {e}")

        self.urls = self._validate_urls(data.get("urls") or [])
        self.polling_interval = data.get("pollInterval", 60)
        self.timeout = data.get("timeout", 10)
```

Deux détails qui comptent :

`yaml.safe_load(stream) or {}` : si le fichier est vide, `safe_load` renvoie `None`. Le `or {}` évite un crash sur un `.get()` derrière.

`_validate_urls` : on ne fait pas confiance au YAML. On filtre tout ce qui n'est pas une URL http(s) valide, et on log un warning plutôt que de planter.

```python
@staticmethod
def _validate_urls(urls: list) -> list[str]:
    valid = []
    for url in urls:
        if not isinstance(url, str):
            logger.warning("Skipping non-string URL entry: %s", url)
            continue
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            logger.warning("Skipping invalid URL: %s", url)
            continue
        valid.append(url)
    return valid
```

> Valider la config au démarrage, c'est le meilleur endroit pour échouer. Mieux vaut un crash clair au lancement qu'une URL bancale qui pollue les logs à chaque cycle.

---

## Étape 2 : Le store en mémoire

Pas de base de données ici, on reste simple. Un `dict` d'URLs vers une `deque` bornée.

```python
from collections import deque

store: dict[str, deque] = {}


def add_result(url: str, timestamp: str, response_time: float, status_code: str):
    if url not in store:
        store[url] = deque(maxlen=100)

    store[url].append(
        {
            "timestamp": timestamp,
            "status_code": status_code,
            "response_time_ms": response_time,
        }
    )


def get_result() -> dict:
    return {url: list(results) for url, results in store.items()}
```

`deque(maxlen=100)` : la structure parfaite ici. Quand elle atteint 100 éléments, elle **évince automatiquement le plus ancien**. Pas de logique de nettoyage à écrire, on garde toujours les 100 derniers checks par URL.

> Trade-off assumé : tout est perdu au redémarrage, et ça ne scale pas sur plusieurs instances. Pour de la prod, on brancherait une TimeSeries DB (InfluxDB) et un dashboard Grafana. Mais pour un service simple, c'est overkill.

---

## Étape 3 : Le worker async

C'est le cœur du service. On veut poll toutes les URLs **en parallèle**, sinon une URL qui timeout à 10s ralentirait toutes les autres.

```python
async def check_urls(client: httpx.AsyncClient, config: Config, url: str):
    current_time = datetime.now(timezone.utc).isoformat()
    start = time.perf_counter()

    try:
        async with client.stream("GET", url, timeout=config.timeout) as r:
            status_code = str(r.status_code)
    except httpx.TimeoutException:
        status_code = "TIMEOUT"
    except httpx.RequestError:
        status_code = "CONNECTION_ERROR"
    except Exception as e:
        logger.error("Unexpected error checking %s: %s", url, e)
        status_code = "ERROR"

    elapsed_ms = (time.perf_counter() - start) * 1000
    add_result(url, current_time, elapsed_ms, status_code)
```

Deux points importants ici :

`client.stream("GET", ...)` : on **ne télécharge pas le body**. On ouvre le stream, on lit le status code, on ferme. Pour un health check, seul le code HTTP nous intéresse — pas besoin de rapatrier 2 Mo de HTML.

`time.perf_counter()` : c'est l'horloge monotone, faite pour mesurer des durées. On ne la mélange pas avec `datetime.now()` (qui elle sert au timestamp affiché).

Et la boucle qui orchestre tout ça :

```python
async def poll_urls(config: Config):
    async with httpx.AsyncClient() as client:
        while True:
            cycle_start = asyncio.get_event_loop().time()
            await asyncio.gather(
                *[check_urls(client, config, url) for url in config.urls if url],
                return_exceptions=True,
            )
            elapsed = asyncio.get_event_loop().time() - cycle_start
            await asyncio.sleep(max(0, config.polling_interval - elapsed))
```

`asyncio.gather(...)` : lance tous les checks d'un coup et attend qu'ils finissent tous. C'est là que la parallélisation opère.

`httpx.AsyncClient()` partagé : un seul client pour tous les checks. Il réutilise le pool de connexions au lieu d'en ouvrir une nouvelle à chaque appel.

Le calcul du sleep mérite qu'on s'y arrête :

```python
elapsed = ... - cycle_start
await asyncio.sleep(max(0, config.polling_interval - elapsed))
```

Si on faisait bêtement `sleep(60)`, l'intervalle réel serait de `60s + temps de polling`, et ça **dériverait** dans le temps. En retranchant le temps déjà passé, on garde un intervalle effectif proche des 60s demandées. Le `max(0, ...)` protège le cas où un cycle prendrait plus longtemps que l'intervalle.

---

## Étape 4 : L'API et le cycle de vie

FastAPI expose le store, et surtout démarre le worker en tâche de fond via le `lifespan`.

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    config_path = os.getenv("CONFIG_PATH", "config.yaml")
    config = Config(path=config_path)

    task = asyncio.create_task(poll_urls(config))
    task.add_done_callback(
        lambda t: logger.error("Worker stopped unexpectedly: %s", t.exception())
        if not t.cancelled() and t.exception()
        else None
    )
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)


@app.get("/status")
async def get_status():
    return get_result()
```

Le `lifespan` est le bon endroit pour lancer un worker : la tâche démarre **avec** l'app, dans la même boucle asyncio, et un seul container suffit. Pas de process séparé à gérer.

Le `add_done_callback` sert de garde-fou : si le worker crash sans qu'on l'ait annulé, on log l'erreur au lieu de la voir disparaître silencieusement.

Un appel `GET /status` renvoie :

```json
{
  "https://example.com": [
    {
      "timestamp": "2026-06-09T10:00:00.000000+00:00",
      "status_code": "200",
      "response_time_ms": 143.2
    }
  ]
}
```

---

## Le flux complet

```
config.yaml
     │
     V
  [Config]  ----- valide les URLs
     │
     V
  [worker]  ----- httpx.AsyncClient + asyncio.gather (toutes les URLs en //)
     │              │
     │  toutes      V
     │  les 60s  [store]  ----- deque(maxlen=100) par URL
     │              │
     V              V
 (boucle)      [GET /status]  ----- lit le store et le renvoie en JSON
```

Le worker écrit, l'API lit. Ils ne se croisent jamais.

---

## Le Dockerfile

On veut une image petite et sécurisée. Multi-stage pour ne pas embarquer les outils de build, et un user non-root.

```dockerfile
# Stage 1 : install deps
FROM python:3.13-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Stage 2 : final image
FROM python:3.13-slim
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn
COPY ./python/app /app/

RUN useradd -m user && chown -R user /app
USER user
EXPOSE 8080
CMD ["python", "api.py"]
```

Et le `docker-compose.yml` qui le durcit encore :

```yaml
services:
  health-checker:
    build: .
    ports:
      - "${PORT:-8080}:8080"
    volumes:
      - ./config.yaml:/app/config.yaml:ro   # monté en lecture seule
    restart: unless-stopped
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp
```

Le `config.yaml` est monté en volume read-only : on peut éditer la liste des URLs **sans rebuild l'image**. Et `read_only`, `cap_drop: ALL`, `no-new-privileges` réduisent la surface d'attaque au minimum. Le container ne peut rien écrire, sauf dans le `/tmp` en tmpfs.

---

## Aller plus loin

- **Persistance** : brancher une TimeSeries DB (InfluxDB, Prometheus) pour garder l'historique au-delà du redémarrage et le visualiser dans Grafana.
- **Auth sur `/status`** : acceptable en interne, mais en prod on protégerait l'endpoint avec une API key ou un token JWT.
- **Config à chaud** : aujourd'hui la liste des URLs est lue une seule fois au démarrage. On pourrait la recharger sans restart.
- **Alerting** : déclencher une notification (Slack, mail) quand une URL enchaîne plusieurs échecs.

Chacun de ces points mérite son propre article. On les traitera plus tard.
