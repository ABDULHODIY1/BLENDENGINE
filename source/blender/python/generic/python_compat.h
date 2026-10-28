/* SPDX-License-Identifier: GPL-2.0-or-later */

/** \file
 * \ingroup pygen
 *
 * Compatibility macros for building against several CPython versions.
 */

#pragma once

#include <Python.h>

/* Python 3.12 added an `initialized` member at the start of `_PyArg_Parser`,
 * use this as the first entry of every static `_PyArg_Parser` initializer. */
#if PY_VERSION_HEX >= 0x030c0000
#  define PY_ARG_PARSER_HEAD_COMPAT() 0,
#else
#  define PY_ARG_PARSER_HEAD_COMPAT()
#endif
