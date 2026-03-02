FROM denoland/deno:2.7.1

EXPOSE 8000

WORKDIR /app

COPY . .
# COPY .env .

CMD ["run", "--env-file", "-A", "index.ts"]
