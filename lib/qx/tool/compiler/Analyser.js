/* ************************************************************************
 *
 *    qooxdoo-compiler - node.js based replacement for the Qooxdoo python
 *    toolchain
 *
 *    https://github.com/qooxdoo/qooxdoo-compiler
 *
 *    Copyright:
 *      2011-2017 Zenesis Limited, http://www.zenesis.com
 *
 *    License:
 *      MIT: https://opensource.org/licenses/MIT
 *
 *      This software is provided under the same licensing terms as Qooxdoo,
 *      please see the LICENSE file in the Qooxdoo project's top-level directory
 *      for details.
 *
 *    Authors:
 *      * John Spackman (john.spackman@zenesis.com, @johnspackman)
 *
 * *********************************************************************** */

/* eslint no-nested-ternary: 0 */
/* eslint no-inner-declarations: 0 */


var fs = require("fs");
var async = require("async");
require("qooxdoo");
var util = require("./util");
var jsonlint = require("jsonlint");

require("./ClassFile");
require("./app/Library");
require("./resources/Manager");

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

var log = util.createLog("analyser");

/**
 * Entry point for analysing source files; maintains a list of known libraries
 * (eg Qx app, contrib, Qx framework etc), known classes (and the files and
 * library in which the class is defined, and environment checks which have been
 * used (env checks imply a dependency).
 */
module.exports = qx.Class.define("qx.tool.compiler.Analyser", {
  extend: qx.core.Object,

  /**
   * Constructor
   *
   * @param dbFilename
   *          {String} the name of the database, defaults to "db.json"
   */
  construct: function(dbFilename) {
    this.base(arguments);

    this.__dbFilename = dbFilename || "db.json";
    this.__libraries = [];
    this.__librariesByNamespace = {};
    this.__initialClassesToScan = new qx.tool.compiler.utils.IndexedArray();
    this.__locales = ["en"];
    this.__cldrs = {};
    this.__translations = {};
    this.__classFiles = {};
    this.__environmentChecks = {};
  },

  properties: {
    /** Output directory for the compiled application */
    outputDir: {
      nullable: true,
      check: "String"
    },

    /** Whether to preserve line numbers */
    trackLineNumbers: {
      check: "Boolean",
      init: false,
      nullable: false
    },

    /** Whether to process resources */
    processResources: {
      init: true,
      nullable: false,
      check: "Boolean"
    },

    /** Whether to add `$$createdAt` to new objects */
    addCreatedAt: {
      init: false,
      nullable: false,
      check: "Boolean"
    },

    /** Environment during compile time */
    environment: {
      init: null,
      check: "Map"
    },
    /** options sent to babel preset */
    babelOptions: {
      init: null,
      nullable: true,
      check: "Object"
    }

  },

  events: {
    /** 
     * Fired when a class is about to be compiled; data is a map:
     * 
     * dbClassInfo: {Object} the newly populated class info 
     * oldDbClassInfo: {Object} the previous populated class info 
     * classFile - {ClassFile} the qx.tool.compiler.ClassFile instance
     */
    "compilingClass": "qx.event.type.Data",
    
    /** 
     * Fired when a class is compiled; data is a map:
     * dbClassInfo: {Object} the newly populated class info 
     * oldDbClassInfo: {Object} the previous populated class info 
     * classFile - {ClassFile} the qx.tool.compiler.ClassFile instance
     */
    "compiledClass": "qx.event.type.Data",
    
    /** 
     * Fired when the database is been saved
     * database: {Object} the database to save
     */
    "saveDatabase": "qx.event.type.Data"
  },

  members: {
    __opened: false,
    __resManager: null,
    __dbFilename: null,
    __db: null,

    /** {Library[]} All libraries */
    __libraries: null,
    
    /** {Map{String,Library}} Lookup of libraries, indexed by namespace */
    __librariesByNamespace: null,

    __classes: null,
    __initialClassesToScan: null,
    __locales: null,
    __cldrs: null,
    __translations: null,

    __classFiles: null,
    __environmentChecks: null,
    __inDefer: false,
    __qooxdooVersion: null,

    /**
     * Opens the analyser, loads database etc
     * 
     * @async
     */
    open: function() {
      var t = this;

      var p;
      if (!this.__opened) {
        this.__opened = true;

        var resManager = null;
        if (this.isProcessResources()) {
          resManager = new qx.tool.compiler.resources.Manager(this);
        }
        this.__resManager = resManager;
        p = Promise.all(
            [ 
              util.promisifyThis(t.loadDatabase, t),
              new Promise((resolve, reject) => {
                if (resManager) {
                  log.debug("Loading resource database");
                  return util.promisifyThis(resManager.loadDatabase, resManager)
                    .then(resolve)
                    .catch(reject);
                }
                resolve();
                return undefined;
              })
            ]);
      } else {
        p = Promise.resolve(); 
      }

      return p.then(() => {
          log.debug("Scanning source code");
          return util.promisifyThis(t.initialScan, t);
        })
        .then(() => {
          log.debug("Saving database");
          return t.saveDatabase();
        });
    },

    /**
     * Scans the source files for javascript class and resource references and
     * calculates the dependency tree
     *
     * @param cb
     */
    initialScan: function(cb) {
      var t = this;
      if (!this.__db) {
        this.__db = {};
      }
      async.parallel(
          [
            // Load Resources
            function(cb) {
              if (!t.__resManager) {
                cb(null);
                return;
              }

              t.__resManager.findAllResources(function(err) {
                if (err) {
                  cb(err);
                  return;
                }
                log.debug("found all resources");
                cb(null);
              });
            },

            // Find all classes
            function(cb) {
              async.each(t.__libraries,
                  function(library, cb) {
                    library.scanForClasses(err => {
                      log.debug("Finished scanning for " + library.getNamespace());
                      cb(err);
                    });
                  },
                  err => {
                    log.debug("Finished scanning for all libraries");
                    cb(err);
                  });
            }
          ],
          function(err) {
            log.debug("processed source and resources");
            cb(err);
          });
    },

    /**
     * Loads the database if available
     *
     * @param cb
     */
    loadDatabase: function(cb) {
      var t = this;
      async.waterfall(
          [
            /**
             * Reads the db.json, if it exists
             *
             * @param cb
             */
            function readDb(cb) {
              fs.exists(t.getDbFilename(), function(exists) {
                if (exists) {
                  fs.readFile(t.getDbFilename(), {encoding: "utf-8"}, cb); 
                } else {
                  cb(null, null); 
                }
              });
            },

            /**
             * Parses the db.json into db
             *
             * @param data
             * @param cb
             */
            function parseDb(data, cb) {
              if (data && data.trim().length) {
                log.debug("Parsing database");
                t.__db = jsonlint.parse(data);
              } else {
                log.debug("No database to parse");
                t.__db = {};
              }
              cb(null, t.__db);
            }
          ],

          /**
           * Done
           * @param err
           * @param result
           */
          function(err, result) {
            log.debug("loaded database: err=" + err);
            cb();
          });
    },

    /**
     * Saves the database
     */
    saveDatabase: async function() {
      log.debug("saving generator database");
      this.fireDataEvent("saveDatabase", this.__db);
      await qx.tool.compiler.utils.Json.saveJsonAsync(this.getDbFilename(), this.__db)
        .then(() => this.__resManager && this.__resManager.saveDatabase());
    },

    /**
     * Returns the loaded database
     *
     * @returns
     */
    getDatabase: function() {
      return this.__db;
    },

    /**
     * Parses all the source files recursively until all classes and all
     * dependent classes are loaded
     *
     * @param cb
     */
    analyseClasses: function(cb) {
      var t = this;
      if (!this.__db) {
        this.__db = {}; 
      }
      var db = this.__db;
      var metaWrittenLog = {};
      
      var compiledClasses = {};
      var metaFixupDescendants = {};
      var listenerId = this.addListener("compiledClass", function(evt) {
        var data = evt.getData();
        if (data.oldDbClassInfo) {
          if (data.oldDbClassInfo.extends) {
            metaFixupDescendants[data.oldDbClassInfo.extends] = true; 
          }
          if (data.oldDbClassInfo.implement) {
            data.oldDbClassInfo.implement.forEach(name => metaFixupDescendants[name] = true);
          }
          if (data.oldDbClassInfo.include) {
            data.oldDbClassInfo.include.forEach(name => metaFixupDescendants[name] = true);
          }
        }
        
        if (data.dbClassInfo.extends) {
          metaFixupDescendants[data.dbClassInfo.extends] = true; 
        }
        if (data.dbClassInfo.implement) {
          data.dbClassInfo.implement.forEach(name => metaFixupDescendants[name] = true);
        }
        if (data.dbClassInfo.include) {
          data.dbClassInfo.include.forEach(name => metaFixupDescendants[name] = true); 
        }

        compiledClasses[data.classFile.getClassName()] = data;
      });
      
      // Note that it is important to pre-load the classes in all libraries - this is because
      //  Babel plugins MUST be synchronous (ie cannot afford an async lookup of files on disk
      //  in mid parse)
      async.each(this.__libraries, function(library, cb) {
        library.scanForClasses(cb);
      }, function() {
        var classIndex = 0;
        var classes = t.__classes = t.__initialClassesToScan.toArray();

        function getConstructDependencies(className) {
          var deps = [];
          var info = t.__db.classInfo[className];
          if (info.dependsOn) {
            for (var depName in info.dependsOn) {
              if (info.dependsOn[depName].construct) {
                deps.push(depName);
              }
            }
          }
          return deps;
        }

        function getIndirectLoadDependencies(className) {
          var deps = [];
          var info = t.__db.classInfo[className];
          if (info && info.dependsOn) {
            for (var depName in info.dependsOn) {
              if (info.dependsOn[depName].load) {
                getConstructDependencies(depName).forEach(function(className) {
                  deps.push(className);
                });
              }
            }
          }
          return deps;
        }

        async.whilst(
            /* While */
            function() {
              return classIndex < classes.length;
            },
            /* Do */
            function(cb) {
              t.getClassInfo(classes[classIndex++], (err, dbClassInfo) => {
                if (dbClassInfo) {
                  var deps = dbClassInfo.dependsOn;
                  for (var depName in deps) {
                    t._addRequiredClass(depName);
                  }
                }
                if (err && err.code === "ENOCLASSFILE") {
                  console.error(err.message);
                  err = null;
                }
                return cb(err);
              });
            },
            /* Done */
            function(err) {
              if (err) {
                cb && cb(err);
                return;
              }
              classes.forEach(function(className) {
                var info = t.__db.classInfo[className];
                var deps = getIndirectLoadDependencies(className);
                deps.forEach(function(depName) {
                  if (!info.dependsOn) {
                    info.dependsOn = {}; 
                  }
                  if (!info.dependsOn[depName]) {
                    info.dependsOn[depName] = {}; 
                  }
                  info.dependsOn[depName].load = true;
                });
              });
              t.removeListenerById(listenerId);
              analyzeMeta()
                .then(() => cb())
                .catch(err => cb(err));
            }
        );
      });
      
      function fixupMetaData(classname, meta) {
        function fixupEntry(obj) {
          if (obj && obj.jsdoc) {
            qx.tool.compiler.jsdoc.Parser.parseJsDoc(obj.jsdoc, classname, t); 
          }
        }
        function fixupSection(sectionName) {
          var section = meta[sectionName];
          if (section) {
            for (var name in section) {
              fixupEntry(section[name]); 
            }
          }
        }

        fixupSection("properties");
        fixupSection("events");
        fixupSection("members");
        fixupSection("statics");
        fixupEntry(meta.clazz);
        fixupEntry(meta.construct);
        fixupEntry(meta.destruct);
        fixupEntry(meta.defer);
      }

      async function updateMetaData(classname, meta) {
        var classEntities = {
            members: {},
            properties: {}
        };
        
        async function analyseClassEntities(meta, first) {
          if (typeof meta == "string") {
            meta = await loadMetaData(meta); 
          }
          if (!meta) {
            return;
          }
          
          [ "members", "properties" ].forEach(entityTypeName => {
            if (!meta[entityTypeName]) {
              return;
            }
            
            for (let entityName in meta[entityTypeName]) {
              let entityMeta = meta[entityTypeName][entityName];
              if (entityMeta.type === "function" || entityTypeName === "properties") {
                var entityInfo = classEntities[entityTypeName][entityName];
                if (!entityInfo) {
                  entityInfo = classEntities[entityTypeName][entityName] = {
                    appearsIn: {},
                    overriddenFrom: null,
                    jsdoc: null,
                    abstract: meta.type === "interface",
                    mixin: meta.type === "mixin",
                    inherited: !first,
                    access: entityName.startsWith("__") ? "private" : entityName.startsWith("_") ? "protected" : "public"
                  };
                }
                if (entityMeta.property) {
                  entityInfo.property = entityMeta.property;
                } 
                if (meta.type === "mixin" && entityInfo.abstract) {
                  entityInfo.mixin = true; 
                }
                if (meta.type !== "interface") {
                  entityInfo.abstract = false;
                } else {
                  entityInfo["interface"] = true; 
                }

                if (!first) {
                  entityInfo.appearsIn[meta.className] = meta.type; 
                }
                if (!first && !entityInfo.overriddenFrom) {
                  entityInfo.overriddenFrom = meta.className; 
                }
                
                if (!entityInfo.jsdoc && hasSignature(entityMeta.jsdoc)) {
                  entityInfo.jsdoc = entityMeta.jsdoc;
                }
              }
            }
          });
          
          if (meta.interfaces) {
            for (let i = 0; i < meta.interfaces.length; i++) {
              await analyseClassEntities(meta.interfaces[i]); 
            }
          }
          if (meta.mixins) {
            for (let i = 0; i < meta.mixins.length; i++) {
              await analyseClassEntities(meta.mixins[i]);
            }
          }
          if (meta.superClass) {
            // Arrays of superclass are allowed for interfaces
            if (qx.lang.Type.isArray(meta.superClass)) {
              for (var i = 0; i < meta.superClass.length; i++) {
                await analyseClassEntities(meta.superClass[i]); 
              }
            } else {
              await analyseClassEntities(meta.superClass); 
            }
          }
          
          if (meta.properties) {
            function addPropertyAccessor(propertyMeta, methodName, accessorType, returnType, valueType, desc) {
              var entityInfo = classEntities.members[methodName];
              if (!entityInfo || entityInfo.abstract) {
                var newInfo = classEntities.members[methodName] = {
                    appearsIn: entityInfo ? entityInfo.appearsIn : {},
                    overriddenFrom: (entityInfo && entityInfo.appearsIn[0]) || null,
                    jsdoc: {
                      "@description": [
                        {
                          "name": "@description",
                          "body": desc
                        }
                      ]
                    },
                    property: accessorType,
                    inherited: !first,
                    mixin: propertyMeta.mixin,
                    access: "public"
                  };
                if (returnType) {
                  newInfo.jsdoc["@return"] = [
                      {
                        "name": "@return",
                        "type": returnType,
                        "desc": "Returns the value for " + propertyMeta.name
                      }
                    ];
                }
                if (valueType) {
                  newInfo.jsdoc["@param"] = [
                    {
                      "name": "@param",
                      "type": valueType,
                      "paramName": "value",
                      "desc": "Value for " + propertyMeta.name
                    }
                  ];
                }
              }
            }
            for (let propertyName in meta.properties) {
              let propertyMeta = meta.properties[propertyName];
              let upname = qx.lang.String.firstUp(propertyName);
              let type = propertyMeta.check || "any";
              
              let msg = "Gets the (computed) value of the property <code>" + propertyName + "</code>.\n" +
                "\n" +
                "For further details take a look at the property definition: {@link #" + propertyName + "}.";
              addPropertyAccessor(propertyMeta, "get" + upname, "get", type, null, msg);
              if (type == "Boolean") {
                addPropertyAccessor(propertyMeta, "is" + upname, "is", type, null, msg); 
              }
              
              addPropertyAccessor(propertyMeta, "set" + upname, "set", null, type, 
                  "Sets the user value of the property <code>" + propertyName + "</code>.\n" +
                  "\n" +
                  "For further details take a look at the property definition: {@link #" + propertyName + "}.");
              
              addPropertyAccessor(propertyMeta, "reset" + upname, "reset", null, null, 
                  "Resets the user value of the property <code>" + propertyName + "</code>.\n" +
                  "\n" + 
                  "The computed value falls back to the next available value e.g. appearance, init or inheritance value " +
                  "depending on the property configuration and value availability.\n" +
                  "\n" + 
                  "For further details take a look at the property definition: {@link #" + propertyName + "}.");
              
              if (propertyMeta.async) {
                msg = "Returns a {@link qx.Promise} which resolves to the (computed) value of the property <code>" + propertyName + "</code>." +
                "\n" +
                "For further details take a look at the property definition: {@link #" + propertyName + "}.";
                addPropertyAccessor(propertyMeta, "get" + upname + "Async", "getAsync", "Promise", null, msg);
                if (type == "Boolean") {
                  addPropertyAccessor(propertyMeta, "is" + upname + "Async", "isAsync", "Promise", null, msg); 
                }
                addPropertyAccessor(propertyMeta, "set" + upname + "Async", "setAsync", "Promise", type, 
                    "Sets the user value of the property <code>" + propertyName + "</code>, returns a {@link qx.Promise} " +
                    "which resolves when the value change has fully completed (in the case where there are asynchronous apply methods or events).\n" +
                    "\n" +
                    "For further details take a look at the property definition: {@link #" + propertyName + "}.");
              }
            }
          }
        }
        
        function hasSignature(jsdoc) {
          return jsdoc &&
            ((jsdoc["@param"] && jsdoc["@param"].length) || 
            (jsdoc["@return"] && jsdoc["@return"].length));
        }
        
        function mergeSignature(src, meta) {
          if (!src) {
            return; 
          }
          // src has nothing?  ignore it.  meta already has a signature?  preserve it
          if (!hasSignature(src) || hasSignature(meta.jsdoc)) {
            return; 
          }
          if (!meta.jsdoc) {
            meta.jsdoc = {}; 
          }
          if (src["@param"]) {
            meta.jsdoc["@param"] = qx.lang.Array.clone(src["@param"]);
          }
          if (src["@return"]) {
            meta.jsdoc["@return"] = qx.lang.Array.clone(src["@return"]);
          }
        }

        await analyseClassEntities(meta, true);
        
        if (meta.properties) {
          for (let propertyName in meta.properties) {
            let propertyMeta = meta.properties[propertyName];
            if (propertyMeta.refine) {
              let result = classEntities.properties[propertyName];
              if (result) {
                propertyMeta.overriddenFrom = result.overriddenFrom;
                propertyMeta.appearsIn = result.appearsIn;
                mergeSignature(result.jsdoc, propertyMeta);
              }
            }
          }
          
          for (let propertyName in classEntities.properties) {
            let propertyInfo = classEntities.properties[propertyName];
            if ((propertyInfo.abstract || propertyInfo.mixin) && !meta.properties[propertyInfo]) {
              let propertyMeta = meta.properties[propertyName] = {
                  type: "property",
                  name: propertyName,
                  abstract: Boolean(propertyInfo.abstract),
                  mixin: Boolean(propertyInfo.mixin),
                  access: propertyInfo.access,
                  overriddenFrom: propertyInfo.overriddenFrom
                };
              if (propertyInfo.appearsIn.length) {
                propertyMeta.appearsIn = Object.keys(propertyInfo.appearsIn); 
              }
              if (propertyMeta.appearsIn && !propertyMeta.appearsIn.length) {
                delete propertyMeta.appearsIn;
              }
              if (propertyInfo.jsdoc) {
                propertyMeta.jsdoc = propertyInfo.jsdoc; 
              }
              if (propertyInfo.overriddenFrom) {
                propertyMeta.overriddenFrom = propertyInfo.overriddenFrom;
              }
              if (!propertyMeta.overriddenFrom) {
                delete propertyMeta.overriddenFrom; 
              }
            }
          }
        }
        
        if (!meta.members) {
          meta.members = {};
        }
        for (let memberName in meta.members) {
          let memberMeta = meta.members[memberName];
          if (memberMeta.type === "function") {
            let result = classEntities.members[memberName];
            if (result) {
              memberMeta.overriddenFrom = result.overriddenFrom;
              memberMeta.appearsIn = Object.keys(result.appearsIn);
              mergeSignature(result.jsdoc, memberMeta);
            }
          }
        }
        for (let memberName in classEntities.members) {
          let memberInfo = classEntities.members[memberName];
          let memberMeta = meta.members[memberName];
          if (memberMeta && memberMeta.type === "variable" && memberInfo) {
            memberMeta.type = "function"; 
          }
          if ((memberInfo.abstract || memberInfo.mixin || memberInfo.property) && !memberMeta) {
            let memberMeta = meta.members[memberName] = {
                type: "function",
                name: memberName,
                abstract: Boolean(memberInfo.abstract),
                mixin: Boolean(memberInfo.mixin),
                inherited: Boolean(memberInfo.inherited),
                access: memberInfo.access,
                overriddenFrom: memberInfo.overriddenFrom
              };
            if (memberInfo.property) {
              memberMeta.property = memberInfo.property;
            }
            if (memberInfo.appearsIn.length) {
              memberMeta.appearsIn = Object.keys(memberInfo.appearsIn);
            }
            if (memberInfo.jsdoc) {
              memberMeta.jsdoc = memberInfo.jsdoc; 
            }
            if (memberInfo.overriddenFrom) {
              memberMeta.overriddenFrom = memberInfo.overriddenFrom; 
            }
            if (memberMeta.abstract) {
              meta.abstract = true;
            }
          }
        }
        for (let memberName in meta.members) {
          let memberMeta = meta.members[memberName];
          if (memberMeta.appearsIn && !memberMeta.appearsIn.length) {
            delete memberMeta.appearsIn;
          }
          if (!memberMeta.overriddenFrom) {
            delete memberMeta.overriddenFrom;
          }
        }
        if (Object.keys(meta.members).length == 0) {
          delete meta.members; 
        }
      }
      
      var cachedMeta = {};
      
      async function saveMetaData(classname, meta) {
        if (metaWrittenLog[classname]) {
          console.log(" *** ERRROR *** Writing " + classname + " more than once");
          throw new Error(" *** ERRROR *** Writing " + classname + " more than once");
        }
        metaWrittenLog[classname] = true;
        var filename = qx.tool.compiler.ClassFile.getOutputPath(t, classname) + "on";
        return writeFile(filename, JSON.stringify(meta, null, 2), {encoding: "utf-8"});
      }
      
      async function loadMetaData(classname) {
        if (classname == "Object" || classname == "Array" || classname == "Error") {
          return Promise.resolve(null); 
        }
        if (cachedMeta[classname]) {
          return Promise.resolve(cachedMeta[classname]); 
        }
        var filename = qx.tool.compiler.ClassFile.getOutputPath(t, classname) + "on";
        return readFile(filename, {encoding: "utf-8"})
          .then(str => jsonlint.parse(str))
          .then(meta => cachedMeta[classname] = meta)
          .catch(err => {
            console.error("Failed to load meta for " + classname + ": " + err);
          });
      }
      
      function calcDescendants(classname, meta) {
        meta.descendants = [];
        for (var name in db.classInfo) {
          var tmp = db.classInfo[name];
          if (tmp.extends == classname) {
            meta.descendants.push(name); 
          }
        }
      }
      
      async function analyzeMeta() {
        var toSave = {};
        for (let classname in compiledClasses) {
          let meta = cachedMeta[classname] = compiledClasses[classname].classFile.getOuterClassMeta();
          // Null meta means that the class didn't compile anything
          if (meta) {
            fixupMetaData(classname, meta); 
          }
        }
        
        for (let classname in compiledClasses) {
          let meta = cachedMeta[classname];
          if (meta) {
            await updateMetaData(classname, meta);
            calcDescendants(classname, meta);
            toSave[classname] = meta;
          }
        }
        
        var p = Promise.resolve();
        for (let classname in metaFixupDescendants) {
          if (!compiledClasses[classname] && db.classInfo[classname]) {
            p = p.then(() => loadMetaData(classname)
                .then(meta => {
                  if (meta) {
                    calcDescendants(classname, meta);
                    toSave[classname] = meta;
                  }
                }));
          }
        }

        await p.then(() => Promise.all(Object.keys(toSave).map(classname => saveMetaData(classname, toSave[classname]))));
      }
    },

    /**
     * Called when a reference to a class is made
     * @param className
     * @private
     */
    _addRequiredClass: function(className) {
      let t = this;

      // __classes will be null if analyseClasses has not formally been called; this would be if the
      //  analyser is only called externally for getClass()
      if (!t.__classes) {
        t.__classes = []; 
      }

      // Add it
      if (t.__classes.indexOf(className) == -1) {
        t.__classes.push(className); 
      }
    },

    /**
     * Returns the full list of required classes
     * @returns {null}
     */
    getDependentClasses: function() {
      return this.__classes;
    },
    
    /**
     * Returns cached class info - returns null if not loaded or not in the database
     * @returb DbClassInfo
     */
    getCachedClassInfo: function(className) {
      return this.__db ? this.__db.classInfo[className] : null;
    },

    /**
     * Loads a class
     * @param className {String} the name of the class
     * @param forceScan {Boolean?} true if the class is to be compiled whether it needs it or not (default false)
     * @param cb(err, DbClassInfo)
     */
    getClassInfo: function(className, forceScan, cb) {
      var t = this;
      if (!this.__db) {
        this.__db = {}; 
      }
      var db = this.__db;
      
      if (typeof forceScan == "function") {
        cb = forceScan;
        forceScan = false;
      }

      if (!db.classInfo) {
        db.classInfo = {};
      }

      var library = t.getLibraryFromClassname(className);
      if (!library) {
        let err = new Error("Cannot find class file " + className);
        err.code = "ENOCLASSFILE";
        cb && cb(err);
        return;
      }
      var sourceClassFilename = qx.tool.compiler.ClassFile.getSourcePath(library, className);
      var outputClassFilename = qx.tool.compiler.ClassFile.getOutputPath(this, className);
      
      function scanFile(stat, outputStat) {
        var dbClassInfo = db.classInfo[className];
        if (dbClassInfo && outputStat) {
          var dbMtime = null;
          try {
            dbMtime = dbClassInfo.mtime && new Date(dbClassInfo.mtime);
          } catch (e) {
          }
          if (dbMtime && dbMtime.getTime() == stat.mtime.getTime()) {
            if (outputStat.mtime.getTime() >= stat.mtime.getTime()) {
              cb && cb(null, dbClassInfo);
              return;
            }
          }
        }
        
        // Add database entry
        var oldDbClassInfo = db.classInfo[className] ? Object.assign({}, db.classInfo[className]) : null;
        dbClassInfo = db.classInfo[className] = {
          mtime: stat.mtime,
          libraryName: library.getNamespace()
        };

        // Analyse it and collect unresolved symbols and dependencies
        var classFile = new qx.tool.compiler.ClassFile(t, className, library);
        t.fireDataEvent("compilingClass", { dbClassInfo: dbClassInfo, oldDbClassInfo: oldDbClassInfo, classFile: classFile });
        classFile.load(function(err) {
          if (err) {
            cb && cb(err);
            return;
          }

          // Save it
          classFile.writeDbInfo(dbClassInfo);

          t.fireDataEvent("compiledClass", { dbClassInfo: dbClassInfo, oldDbClassInfo: oldDbClassInfo, classFile: classFile });

          // Next!
          cb && cb(null, dbClassInfo, classFile);
        });
      }
      
      // Detect whether we need to rescan the file
      fs.stat(sourceClassFilename, function(err, stat) {
        if (err) {
          cb && cb(err);
          return;
        }

        fs.exists(outputClassFilename, function(exists) {
          if (!exists || forceScan) {
            scanFile(stat);
            return;
          }
          fs.exists(outputClassFilename + "on", function(exists) {
            if (!exists) {
              scanFile(stat);
              return;
            }
            
            fs.stat(outputClassFilename, function(err, outputStat) {
              if (err) {
                cb && cb(err);
                return;
              }
  
              scanFile(stat, outputStat);
            });
          });
        });
      });
    },

    /**
     * Returns the CLDR data for a given locale
     * @param locale {String} the locale string
     * @returns Promise({cldr})
     */
    getCldr: async function(locale) {
      var t = this;
      var cldr = this.__cldrs[locale];
      if (cldr) {
        return cldr; 
      }
      return qx.tool.compiler.app.Cldr.loadCLDR(locale)
        .then(cldr => t.__cldrs[locale] = cldr);
    },

    /**
     * Gets the translation for the locale and library, caching teh result.
     * @param library
     * @param locale
     * @returns {Promise(translation)}
     */
    getTranslation: async function(library, locale) {
      var t = this;
      var id = locale + ":" + library.getNamespace();
      var translation = t.__translations[id];
      if (!translation) {
        translation = t.__translations[id] = new qx.tool.compiler.app.Translation(library, locale);
        return translation.checkRead().then(() => translation);
      } 
      return translation;
    },

    /**
     * Updates all translations to include all msgids found in code
     * @param the library to update
     * @param locales
     * @param cb
     */
    updateTranslations: function(library, locales, cb) {
      var t = this;

      async.each(locales, function(locale, cb) {
        var translation = new qx.tool.compiler.app.Translation(library, locale);
        translation.read().then(function(err) {
          if (err) {
            cb && cb(err);
            return;
          }

          Promise.all(t.__classes.map(function(classname) {
            return new Promise((resolve, reject) => {
              if (!classname.startsWith(library.getNamespace())) {
                resolve();
                return;
              }
              t.getClassInfo(classname, function(err, dbClassInfo) {
                if (err) {
                  reject(err);
                  return;
                }
                if (dbClassInfo.translations) {
                  dbClassInfo.translations.forEach(function(src) {
                    var entry = translation.getOrCreateEntry(src.msgid);
                    if (src.msgid_plural) {
                      entry.msgid_plural = src.msgid_plural;
                    }
                    if (src.comment) {
                      entry.comment = src.comment; 
                    }
                    if (!entry.comments) {
                      entry.comments = {}; 
                    }
                    if (!entry.comments.reference) {
                      entry.comments.reference = {};
                    }
                    let ref = entry.comments.reference;
                    const fileName = classname.replace(/\./g, "/") + ".js";
                    if (qx.lang.Type.isArray(src.lineNo)) {
                      src.lineNo.forEach(function(lineNo) {
                        if (!ref[fileName]) {
                          ref[fileName] = [];
                        }
                        if (!ref[fileName].includes(src.lineNo)) {
                          ref[fileName].push(lineNo);
                        }
                      });
                    } else {
                      if (!ref[fileName]) {
                        ref[fileName] = [];
                      }
                      if (!ref[fileName].includes(src.lineNo)) {
                        ref[fileName].push(src.lineNo);
                      }
                    }
                  });
                }
                resolve();
              });
            });
          }))
          .then(() => {
            translation.write(cb);
          });
        });
      }, cb);
    },

    /**
     * Returns the path to the qooxdoo library
     *
     * @returns
     */
    getQooxdooPath: function() {
      var lib = this.findLibrary("qx");
      if (lib !== null) {
        return lib.getRootDir();
      }
      return null;
    },

    /**
     * Finds the library with a name(space)
     */
    findLibrary: function(name) {
      var lib = this.__librariesByNamespace[name];
      return lib;
    },

    /**
     * Returns all libraries
     * @returns {null}
     */
    getLibraries: function() {
      return this.__libraries;
    },

    /**
     * Adds a library definition
     *
     * @param library
     */
    addLibrary: function(library) {
      this.__libraries.push(library);
      this.__librariesByNamespace[library.getNamespace()] = library;
   },

    /**
     * Adds a required class to be analysed by analyseClasses()
     *
     * @param classname
     */
    addClass: function(classname) {
      this.__initialClassesToScan.push(classname);
    },

    /**
     * Removes a class from the list of required classes to analyse
     * @param className
     */
    removeClass: function(classname) {
      this.__initialClassesToScan.remove(classname);
    },

    /**
     * Adds a required Locale
     *
     * @param locale
     */
    addLocale: function(locale) {
      if (this.__locales.indexOf(locale) < 0) {
        this.__locales.push(locale); 
      }
    },

    /**
     * Returns the list of locale IDs
     */
    getLocales: function() {
      return this.__locales;
    },

    /**
     * Detects the symbol type, ie class, package, member, etc
     * @param name
     * @returns {{symbolType,name,clasName?}}
     */
    getSymbolType: function(name) {
      var t = this;
      for (var j = 0; j < t.__libraries.length; j++) {
        var library = t.__libraries[j];
        var info = library.getSymbolType(name);
        if (info) {
          return info;
        }
      }
      return null;
    },

    /**
     * Returns the library for a given classname, supports private files
     * @param className
     * @returns {*}
     */
    getLibraryFromClassname: function(className) {
      var t = this;
      var info = this.__classFiles[className];
      if (info) {
        return info.library; 
      }
      
      for (var j = 0; j < t.__libraries.length; j++) {
        var library = t.__libraries[j];
        info = library.getSymbolType(className);
        if (info && (info.symbolType == "class" || info.symbolType == "member")) {
          return library;
        }
      }
      
      return null;
    },

    /**
     * Returns the classname
     * @param className
     * @returns {string}
     */
    getClassFilename: function(className) {
      var library = this.getLibraryFromClassname(className);
      if (!library) {
        return null; 
      }
      var path = library.getRootDir() + "/" + library.getSourcePath() + "/" + className.replace(/\./g, "/") + ".js";
      return path;
    },

    /**
     * Sets an environment value as being checked for
     *
     * @param key
     * @param value
     */
    setEnvironmentCheck: function(key, value) {
      if (typeof key == "object") {
        var map = key;
        for (key in map) {
          this.__environmentChecks[key] = map[key];
        }
      } else if (value === undefined) {
        delete this.__environmentChecks[key];
      } else {
        this.__environmentChecks[key] = value;
      }
    },

    /**
     * Tests whether an environment value is checked for
     *
     * @param key
     * @returns
     */
    getEnvironmentCheck: function(key) {
      return this.__environmentChecks[key];
    },

    /**
     * Returns the resource manager
     */
    getResourceManager: function() {
      return this.__resManager;
    },

    /**
     * Returns the version of Qooxdoo
     * @returns {String}
     */
    getQooxdooVersion: function() {
      if (this.__qooxdooVersion) {
        return this.__qooxdooVersion;
      }
      if (!this.__qooxdooVersion) {
         let lib = this.findLibrary("qx");
         if (lib) {
          this.__qooxdooVersion = lib.getVersion();  
         }
      }  
      return this.__qooxdooVersion;
    },

    /**
     * Returns the database filename
     * @returns {null}
     */
    getDbFilename: function() {
      return this.__dbFilename;
    },
	
    /**
     * Returns the resource database filename
     * @returns {null}
     */
    getResDbFilename: function() {
      var m = this.__dbFilename.match(/(^.*)\/([^/]+)$/);
      var resDb;
      if (m && m.length == 3) {
        resDb = m[1] + "/resource-db.json";
      } else {
        resDb = "resource-db.json"; 
      }
      return resDb;
    }
	
  }
});
