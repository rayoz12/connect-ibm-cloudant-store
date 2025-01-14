import {CloudantV1 as CloudantClient} from "@ibm-cloud/cloudant";
import * as CloudantV1 from "@ibm-cloud/cloudant/cloudant/v1.js";
import { IBMCloudantStore } from "./lib/connect-ibm-cloudant-store.js";

async function main() {
    const client: CloudantV1 = CloudantClient.newInstance({});
    const cloudantStore = new IBMCloudantStore({
        client
    });
    await cloudantStore.init();
}

main();