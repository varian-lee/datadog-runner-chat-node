FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
EXPOSE 8080
# 애플리케이션 실행 (dd-trace 자동 초기화)
CMD ["node", "-r", "dd-trace/init", "index.js"]
