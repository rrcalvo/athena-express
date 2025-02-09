"use strict";

const readline = require("readline"),
    csv = require("csvtojson");

let s3Metadata = null;

let unflatten = function(data) {
    "use strict";
    if (Object(data) !== data || Array.isArray(data))
        return data;
    var regex = /\.?([^.\[\]]+)|\[(\d+)\]/g,
        resultholder = {};
    for (var p in data) {
        var cur = resultholder,
            prop = "",
            m;
        while (m = regex.exec(p)) {
            cur = cur[prop] || (cur[prop] = (m[2] ? [] : {}));
            prop = m[2] || m[1];
        }
        cur[prop] = data[p];
    }
    return resultholder[""] || resultholder;
};

let flatten = function(data) {
    var result = {};
    function recurse (cur, prop) {
        if (Object(cur) !== cur) {
            result[prop] = cur;
        } else if (Array.isArray(cur)) {
             for(var i=0, l=cur.length; i<l; i++)
                 recurse(cur[i], prop + "[" + i + "]");
            if (l == 0)
                result[prop] = [];
        } else {
            var isEmpty = true;
            for (var p in cur) {
                isEmpty = false;
                recurse(cur[p], prop ? prop+"."+p : p);
            }
            if (isEmpty && prop)
                result[prop] = {};
        }
    }
    recurse(data, "");
    return result;
}

function startQueryExecution(query, config) {
    const QueryString = query.sql || query;

    const params = {
        QueryString,
        WorkGroup: config.workgroup,
        ResultConfiguration: {
            OutputLocation: config.s3Bucket,
        },
        QueryExecutionContext: {
            Database: query.db || config.db,
        },
    };
    if (config.encryption)
        params.ResultConfiguration.EncryptionConfiguration = config.encryption;

    return new Promise(function (resolve, reject) {
        const startQueryExecutionRecursively = async function () {
            try {
                let data = await config.athena
                    .startQueryExecution(params)
                    .promise();
                resolve(data.QueryExecutionId);
            } catch (err) {
                isCommonAthenaError(err.code)
                    ? setTimeout(() => {
                          startQueryExecutionRecursively();
                      }, 2000)
                    : reject(err);
            }
        };
        startQueryExecutionRecursively();
    });
}

function checkIfExecutionCompleted(QueryExecutionId, config) {
    let retry = config.retry;
    return new Promise(function (resolve, reject) {
        const keepCheckingRecursively = async function () {
            try {
                let data = await config.athena
                    .getQueryExecution({
                        QueryExecutionId,
                    })
                    .promise();
                if (data.QueryExecution.Status.State === "SUCCEEDED") {
                    retry = config.retry;
                    s3Metadata = config.athena
                        .getQueryResults({
                            QueryExecutionId,
                            MaxResults: 1,
                        })
                        .promise();
                    resolve(data);
                } else if (data.QueryExecution.Status.State === "FAILED") {
                    reject(data.QueryExecution.Status.StateChangeReason);
                } else {
                    setTimeout(() => {
                        keepCheckingRecursively();
                    }, retry);
                }
            } catch (err) {
                if (isCommonAthenaError(err.code)) {
                    retry = 2000;
                    setTimeout(() => {
                        keepCheckingRecursively();
                    }, retry);
                } else reject(err);
            }
        };
        keepCheckingRecursively();
    });
}

function getQueryResultsFromS3(params) {
    const s3Params = {
            Bucket: params.s3Output.split("/")[2],
            Key: params.s3Output.split("/").slice(3).join("/"),
        },
        input = params.config.s3.getObject(s3Params).createReadStream();

    if (params.config.formatJson) {
        return params.statementType === "UTILITY" ||
            params.statementType === "DDL"
            ? cleanUpNonDML(input)
            : cleanUpDML(input, params.config.ignoreEmpty);
    } else {
        return getRawResultsFromS3(input);
    }
}

function getRawResultsFromS3(input) {
    let rawJson = [];
    return new Promise(function (resolve, reject) {
        readline
            .createInterface({
                input,
            })
            .on("line", (line) => {
                rawJson.push(line.trim());
            })
            .on("close", function () {
                resolve(rawJson);
            });
    });
}

function getDataTypes() {
    return new Promise(async function (resolve) {
        const columnInfoArray = (await s3Metadata).ResultSet.ResultSetMetadata
            .ColumnInfo;
        let columnInfoArrayLength = columnInfoArray.length;
        let columnInfoObject = {};
        while (columnInfoArrayLength--) {
            [columnInfoObject[columnInfoArray[columnInfoArrayLength].Name]] = [
                columnInfoArray[columnInfoArrayLength].Type,
            ];
        }
        resolve(columnInfoObject);
    });
}

async function cleanUpDML(input, ignoreEmpty) {
    let cleanJson = [];
    const dataTypes = await getDataTypes();
    return new Promise(function (resolve) {
        input.pipe(
            csv({
                ignoreEmpty,
            })
                .on("data", (data) => {
                    cleanJson.push(
                        addDataType(
                            JSON.parse(data.toString("utf8")),
                            dataTypes
                        )
                    );
                })
                .on("finish", function () {
                    resolve(cleanJson);
                })
        );
    });
}

function addDataType(input, dataTypes) {
    let updatedObjectWithDataType = {};
    const flat = flatten(input)
    for (const key in flat) {
        switch (dataTypes[key]) {
            case "varchar":
                updatedObjectWithDataType[key] = flat[key];
                break;
            case "boolean":
                if (flat[key]) {
                    updatedObjectWithDataType[key] = JSON.parse(
                        flat[key].toLowerCase()
                    );
                }
                break;
            case "integer":
            case "tinyint":
            case "smallint":
            case "int":
            case "float":
            case "double":
                updatedObjectWithDataType[key] = Number(flat[key]);
                break;
            default:
                updatedObjectWithDataType[key] = flat[key];
        }
    }
    const result = unflatten(updatedObjectWithDataType)
    return result;
}

function cleanUpNonDML(input) {
    let cleanJson = [];
    return new Promise(function (resolve) {
        readline
            .createInterface({
                input,
            })
            .on("line", (line) => {
                switch (true) {
                    case line.indexOf("\t") > 0:
                        line = line.split("\t");
                        cleanJson.push({
                            [line[0].trim()]: line[1].trim(),
                        });
                        break;
                    default:
                        if (line.trim().length) {
                            cleanJson.push({
                                row: line.trim(),
                            });
                        }
                }
            })
            .on("close", function () {
                resolve(cleanJson);
            });
    });
}

function validateConstructor(init) {
    if (!init)
        throw new TypeError("Config object not present in the constructor");

    try {
        let aws = init.s3 ? init.s3 : init.aws.config.credentials.accessKeyId;
        let athena = new init.aws.Athena({
            apiVersion: "2017-05-18",
        });
    } catch (e) {
        throw new TypeError(
            "AWS object not present or incorrect in the constructor"
        );
    }
}

function isCommonAthenaError(err) {
    return err === "TooManyRequestsException" ||
        err === "ThrottlingException" ||
        err === "NetworkingError" ||
        err === "UnknownEndpoint"
        ? true
        : false;
}

module.exports = {
    validateConstructor,
    startQueryExecution,
    checkIfExecutionCompleted,
    getQueryResultsFromS3,
};
