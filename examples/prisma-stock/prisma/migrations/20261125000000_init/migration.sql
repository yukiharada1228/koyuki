CREATE TABLE "Stock" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "units" INTEGER NOT NULL CHECK("units" >= 0),
  "version" INTEGER NOT NULL CHECK("version" > 0)
);
CREATE TABLE "Movement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "units" INTEGER NOT NULL CHECK("units" > 0),
  "sourceVersion" INTEGER NOT NULL,
  "targetVersion" INTEGER NOT NULL
);
