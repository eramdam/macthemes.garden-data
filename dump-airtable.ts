import crypto from "node:crypto";
import Airtable, { type FieldSet, type Records } from "airtable";
import async from "async";
import fs from "fs-extra";
// @ts-expect-error
import { AssetCache } from "@11ty/eleventy-fetch";
import { compact, uniq } from "es-toolkit";

const airtableCache = new AssetCache("garden.macthemes.airtable");

const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN || "" }).base(
  process.env.AIRTABLE_BASE_ID || "",
);

(async () => {
  const records = await grabRawRecords();
  const existingAttachments = fs.globSync("public/themes/attachments/*.png");
  const normalizedRecords = records.map((record) => {
    return {
      name: record.fields["Name"] as string,
      authors: record.fields["Author(s)"] as string,
      year: record.fields["Year"] as string,
      about: (record.fields["About"] as Airtable.Attachment[])?.[0],
      showcase: (record.fields["Showcase"] as Airtable.Attachment[])?.[0],
      archiveFile: (
        record.fields["Archive file"] as Airtable.Attachment[]
      )?.[0],
      archiveFileName2: record.fields["Archive name2"] as string,
      ksaSampler: (
        record.fields["KSA Sampler transparent"] as Airtable.Attachment[]
      )?.[0],
      created: new Date(record.fields["Created"] as string),
    };
  });
  console.log(`Grabbed ${normalizedRecords.length} records`);

  console.log(`Downloading ${normalizedRecords.length * 4} attachments...`);
  const filePaths = await async.flatMapLimit<
    (typeof normalizedRecords)[0],
    { filepath: string; id: string; filename: string }
  >(normalizedRecords, 10, async (record: (typeof normalizedRecords)[0]) => {
    const about = await downloadAttachment(record.about, "about-");
    const ksaSampler = await downloadAttachment(
      record.ksaSampler,
      "ksa-sampler-",
    );
    const showcase = await downloadAttachment(record.showcase, "showcase-");

    return [about, ksaSampler, showcase].filter((f) => !!f);
  });

  const normalizedRecordsWithFilePaths = normalizedRecords
    .map((record) => {
      const archiveName =
        (record.archiveFile?.filename?.endsWith(".sit")
          ? record.archiveFile?.filename
          : record.archiveFileName2) || undefined;

      return {
        ...record,
        showcase: filePaths.find((f) => f.id === record.showcase?.id)?.filepath,
        about: filePaths.find((f) => f.id === record.about?.id)?.filepath,
        archiveFile: undefined,
        archiveFilename: archiveName,
        ksaSampler: filePaths.find((f) => f.id === record.ksaSampler?.id)
          ?.filepath,
      };
    })
    .filter((f) => !!f && Object.values(f).filter((v) => !!v).length)
    .filter((f) => {
      // TODO: use zod or something to do all that validation stuff...
      return Boolean(
        f.name &&
        (f.year || f.authors) &&
        f.about &&
        f.showcase &&
        f.archiveFilename &&
        f.ksaSampler,
      );
    });

  const allFiles = normalizedRecordsWithFilePaths.flatMap((r) => {
    return [r.about, r.ksaSampler, r.showcase];
  });
  const filesToDelete = existingAttachments
    .filter((f): f is string => Boolean(f))
    .filter((file) => !allFiles.includes(file));

  for (const file of filesToDelete) {
    await fs.remove(file);
  }

  await fs.writeFile(
    "airtable.json",
    JSON.stringify(normalizedRecordsWithFilePaths, null, 2),
    "utf-8",
  );

  const archives = uniq(
    compact(normalizedRecordsWithFilePaths.map((r) => r.archiveFilename)),
  );
  async.mapLimit<string, void>(archives, 10, async (record: string) => {
    return downloadArchive(record);
  });
})();

async function downloadArchive(archiveFilename: string) {
  try {
    const md5File = await fetch(
      `https://files.macthemes.garden/${archiveFilename}.md5`,
    );
    const md5FileContent = await md5File.text();
    const md5Remote = md5FileContent.split(" ")[0]?.trim();
    const filepath = `archives/${archiveFilename}`;

    if (await fs.exists(filepath)) {
      const md5OfExisting = await getMd5HashOfFile(filepath);
      if (md5OfExisting === md5Remote) {
        console.log(`[INFO] skipped ${archiveFilename}`);
        return;
      }
    }
    const response = await fetch(
      `https://files.macthemes.garden/${archiveFilename}`,
    );
    await fs.writeFile(filepath, Buffer.from(await response.arrayBuffer()));
    await fs.writeFile(`${filepath}.md5`, md5FileContent);
    console.log(`[INFO] downloaded ${archiveFilename}`);
  } catch (e) {
    console.log("[ERROR] could not download " + archiveFilename);
    console.error(e);
  }
}

async function downloadAttachment(
  attachment: Airtable.Attachment | undefined,
  prefix = "",
): Promise<{ id: string; filepath: string; filename: string } | undefined> {
  if (!attachment) {
    return undefined;
  }
  const filename =
    `${prefix}${attachment.id}-${attachment.filename}`.toLowerCase();
  const filepath = `attachments/${filename}`;

  if (await fs.exists(filepath)) {
    return { id: attachment.id, filepath, filename: attachment.filename };
  }

  const response = await fetch(attachment.url);
  const buffer = await response.arrayBuffer();

  console.log(`Downloaded ${filename}`);
  await fs.writeFile(filepath, Buffer.from(buffer));
  return { id: attachment.id, filepath, filename: attachment.filename };
}

async function grabRawRecords(): Promise<Records<FieldSet>> {
  if (airtableCache.isCacheValid("1d")) {
    return airtableCache.getCachedValue() as unknown as Records<FieldSet>;
  }
  const records = await base("Kaleidoscope Schemes")
    .select({
      maxRecords: 100,
      view: "Grid view",
    })
    .all();

  await airtableCache.save(records, "json");

  return records;
}

function getMd5HashOfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = crypto.createHash("md5");
    const input = fs.createReadStream(path);

    input.on("error", (err) => {
      reject("");
    });

    output.once("readable", () => {
      resolve(output.read().toString("hex"));
    });

    input.pipe(output);
  });
}
